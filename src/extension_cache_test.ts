import { refreshExtensionCache, restoreExtensionCache } from "./extension_cache.ts";

function assertContents(path: string, expected: string): void {
  if (Deno.readTextFileSync(path) !== expected) {
    throw new Error(`Unexpected fixture contents: ${path}`);
  }
}

Deno.test("refresh swaps a complete extension into the stable cache path", () => {
  const fixture = Deno.makeTempDirSync({ dir: "/tmp", prefix: "apw-cache-test-" });
  try {
    const source = `${fixture}/source`;
    const cache = `${fixture}/cache`;
    Deno.mkdirSync(`${source}/_metadata`, { recursive: true });
    Deno.mkdirSync(cache);
    Deno.writeTextFileSync(`${source}/background.js`, "updated fixture");
    Deno.writeTextFileSync(`${source}/version.txt`, "2");
    Deno.writeTextFileSync(`${cache}/background.js.orig`, "old fixture");
    Deno.writeTextFileSync(`${cache}/obsolete.txt`, "old");

    refreshExtensionCache(source, cache, fixture);

    assertContents(`${cache}/background.js`, "updated fixture");
    assertContents(`${cache}/background.js.orig`, "updated fixture");
    assertContents(`${cache}/version.txt`, "2");
    const entries = [...Deno.readDirSync(cache)].map(({ name }) => name).sort();
    if (entries.join(",") !== "background.js,background.js.orig,version.txt") {
      throw new Error("The active cache contains files from the old or unstaged extension");
    }
    if ([...Deno.readDirSync(fixture)].length !== 2) throw new Error("Staging files were not cleaned up");
  } finally {
    Deno.removeSync(fixture, { recursive: true });
  }
});

Deno.test("an incomplete source cannot replace the current cache", () => {
  const fixture = Deno.makeTempDirSync({ dir: "/tmp", prefix: "apw-cache-test-" });
  try {
    const source = `${fixture}/source`;
    const cache = `${fixture}/cache`;
    Deno.mkdirSync(source);
    Deno.mkdirSync(cache);
    Deno.writeTextFileSync(`${cache}/background.js.orig`, "old fixture");

    try {
      refreshExtensionCache(source, cache, fixture);
      throw new Error("The incomplete fixture was accepted");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    assertContents(`${cache}/background.js.orig`, "old fixture");
    if ([...Deno.readDirSync(fixture)].length !== 2) throw new Error("A failed update left staging files");
  } finally {
    Deno.removeSync(fixture, { recursive: true });
  }
});

Deno.test("startup restores the backup when interrupted between renames", () => {
  const fixture = Deno.makeTempDirSync({ dir: "/tmp", prefix: "apw-cache-test-" });
  try {
    const cache = `${fixture}/cache`;
    Deno.mkdirSync(`${cache}.previous`);
    Deno.writeTextFileSync(`${cache}.previous/background.js.orig`, "old fixture");

    restoreExtensionCache(cache);

    assertContents(`${cache}/background.js.orig`, "old fixture");
  } finally {
    Deno.removeSync(fixture, { recursive: true });
  }
});
