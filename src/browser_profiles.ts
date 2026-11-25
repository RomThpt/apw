// Locates the installed Apple Passwords extension across browser profiles, skipping folders the
// current user is not allowed to read.

export interface ProfileReader {
  /** Directory names under `path`: `[]` when it does not exist, `null` when access is denied. */
  directories(path: string): string[] | null;
  isFile(path: string): boolean;
}

export interface ExtensionSearch {
  path?: string;
  inaccessible: string[];
}

export function findExtensionSource(
  dataPaths: string[],
  extensionId: string,
  entry: string,
  fs: ProfileReader,
): ExtensionSearch {
  const inaccessible: string[] = [];
  const list = (path: string) => {
    const names = fs.directories(path);
    if (names === null) inaccessible.push(path);
    return names ?? [];
  };

  for (const dataPath of dataPaths) {
    let newest: { path: string; version: string } | undefined;
    for (const profile of list(dataPath)) {
      const base = `${dataPath}/${profile}/Extensions/${extensionId}`;
      const versions = list(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) {
        const path = `${base}/${version}`;
        if (!fs.isFile(`${path}/${entry}`)) continue;
        if (!newest || version.localeCompare(newest.version, undefined, { numeric: true }) > 0) {
          newest = { path, version };
        }
        break;
      }
    }
    if (newest) return { path: newest.path, inaccessible };
  }
  return { inaccessible };
}

export function missingExtensionMessage(inaccessible: string[]): string {
  const message = "Apple Passwords extension not found. Install it from the Chrome Web Store.";
  if (!inaccessible.length) return message;
  return `${message}\nThese folders could not be read (permission denied):\n${
    inaccessible.map((path) => `  ${path}`).join("\n")
  }`;
}
