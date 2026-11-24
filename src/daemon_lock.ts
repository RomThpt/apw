// Single-instance guard for the daemon. An exclusive advisory lock is held on a stable file for the
// daemon's lifetime. The OS releases it when the process exits, including after a crash, so the
// file is never deleted (deleting it would let two daemons lock different inodes).

export interface LockFile {
  tryLockSync?: (exclusive?: boolean) => boolean;
  close(): void;
}

export class AlreadyRunningError extends Error {
  constructor() {
    super("APW daemon is already running");
  }
}

/** Opens the lock file and takes the lock without blocking; the caller must keep the file open. */
export function acquireSingletonLock<T extends LockFile>(open: () => T): T {
  const file = open();
  try {
    if (typeof file.tryLockSync !== "function") {
      throw new Error("This Deno runtime does not provide FsFile.tryLockSync");
    }
    if (!file.tryLockSync(true)) throw new AlreadyRunningError();
    return file;
  } catch (error) {
    file.close();
    throw error;
  }
}
