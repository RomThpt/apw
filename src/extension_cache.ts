function exists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function removeIfPresent(path: string): void {
  if (exists(path)) Deno.removeSync(path, { recursive: true });
}

function copyDirectory(source: string, target: string): void {
  for (const entry of Deno.readDirSync(source)) {
    const from = `${source}/${entry.name}`;
    const to = `${target}/${entry.name}`;
    if (entry.isDirectory) {
      Deno.mkdirSync(to);
      copyDirectory(from, to);
    } else if (entry.isFile) {
      Deno.copyFileSync(from, to);
    }
  }
}

/** Recover the previous complete cache if the daemon stopped between the two renames. */
export function restoreExtensionCache(target: string): void {
  const backup = `${target}.previous`;
  if (!exists(target) && exists(backup)) Deno.renameSync(backup, target);
}

/** Prepare a complete replacement on the same volume before moving the active cache. */
export function refreshExtensionCache(source: string, target: string, dataPath: string): void {
  const backup = `${target}.previous`;
  const stage = Deno.makeTempDirSync({ dir: dataPath, prefix: "extension-update-" });
  try {
    copyDirectory(source, stage);
    removeIfPresent(`${stage}/_metadata`);
    Deno.copyFileSync(`${stage}/background.js`, `${stage}/background.js.orig`);

    removeIfPresent(backup);
    if (exists(target)) Deno.renameSync(target, backup);
    try {
      Deno.renameSync(stage, target);
    } catch (error) {
      restoreExtensionCache(target);
      throw error;
    }
    removeIfPresent(backup);
  } finally {
    removeIfPresent(stage);
  }
}
