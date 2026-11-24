// Chromium's `--remote-debugging-pipe` reads DevTools commands from FD 3 and writes replies to FD 4,
// each message being JSON terminated by a NUL byte. Deno cannot hand extra descriptors to a child,
// so a fixed shell script moves our stdin/stdout pipes onto FD 3/4 and then execs the browser.
// The browser path and flags travel as separate argv entries and are never parsed by the shell.

import { isRecord, NulJsonSplitter } from "./framing.ts";

export const PIPE_SHELL = "/bin/sh";
export const PIPE_SCRIPT = 'exec "$@" 3<&0 4>&1 </dev/null >/dev/null';
export const MAX_PIPE_MESSAGE_BYTES = 1024 * 1024;

/** Arguments for `PIPE_SHELL` that exec `bin` with `args` and FD 3/4 wired to our pipes. */
export function pipeShellArgs(bin: string, args: string[]): string[] {
  return ["-c", PIPE_SCRIPT, "sh", bin, ...args];
}

export function encodePipeCommand(command: { id: number; method: string; params?: unknown }): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(command)}\0`);
}

/**
 * Waits for the reply to command `id`, ignoring other messages. Fails if the pipe closes, the
 * browser exits, a message is malformed or oversized, or `timeoutMs` elapses.
 */
export async function awaitPipeResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  id: number,
  options: { timeoutMs: number; exited: Promise<unknown>; maxBytes?: number },
): Promise<Record<string, unknown>> {
  const splitter = new NulJsonSplitter(options.maxBytes ?? MAX_PIPE_MESSAGE_BYTES);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reply = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Browser closed its DevTools pipe during startup");
      for (const message of splitter.push(value)) {
        if (message.id === id) return message;
      }
    }
  })();
  const exit = options.exited.then(() => {
    throw new Error("Browser exited during startup");
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Browser DevTools pipe did not respond in time")), options.timeoutMs);
  });

  try {
    return await Promise.race([reply, exit, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Returns the error message of a DevTools reply, if it reports one. */
export function pipeResponseError(response: Record<string, unknown>): string | undefined {
  if (!("error" in response)) return;
  const { error } = response;
  return isRecord(error) && typeof error.message === "string" ? error.message : "DevTools command failed";
}

/** Keeps reading so the browser never blocks on a full pipe. Never rejects. */
export async function drainPipe(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    while (!(await reader.read()).done);
  } catch {
    // The browser went away; nothing left to drain.
  }
}
