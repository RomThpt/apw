// Synthetic tests for the daemon and browser lifecycle helpers. Everything here is in-memory:
// no sockets, browsers, extensions, credentials or file system access.

import { findExtensionSource, missingExtensionMessage, type ProfileReader } from "./browser_profiles.ts";
import { acquireSingletonLock, AlreadyRunningError } from "./daemon_lock.ts";
import {
  awaitPipeResponse,
  encodePipeCommand,
  PIPE_SCRIPT,
  pipeResponseError,
  pipeShellArgs,
} from "./devtools_pipe.ts";
import { type BridgeSocket, ExtensionSession, SessionUnavailableError } from "./extension_session.ts";
import { FrameError, NulJsonSplitter, readLineFrame, writeAll } from "./framing.ts";
import type { Message } from "./types.ts";

function assertEqual(actual: unknown, expected: unknown, label = "value") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected ${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

async function assertRejects(promise: Promise<unknown>, check: (error: unknown) => boolean, label: string) {
  try {
    await promise;
  } catch (error) {
    if (check(error)) return;
    throw new Error(`Unexpected error for ${label}: ${error}`);
  }
  throw new Error(`Expected ${label} to fail`);
}

function assertThrows(fn: () => unknown, check: (error: unknown) => boolean, label: string) {
  return assertRejects(Promise.resolve().then(fn), check, label);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const bytes = (text: string) => new TextEncoder().encode(text);

/** A `read` function that serves the given chunks, then EOF. */
function chunkedReader(chunks: Uint8Array[]) {
  let index = 0;
  return (buffer: Uint8Array) => {
    const chunk = chunks[index++];
    if (!chunk) return Promise.resolve(null);
    buffer.set(chunk);
    return Promise.resolve(chunk.length);
  };
}

// --- Unix socket framing -------------------------------------------------------------------------

Deno.test("line frames survive multi-byte characters split across reads", async () => {
  const encoded = bytes('{"cmd":4,"url":"é🔑"}\n');
  const chunks = [...encoded].map((byte) => Uint8Array.of(byte));
  assertEqual(await readLineFrame(chunkedReader(chunks), 1024), '{"cmd":4,"url":"é🔑"}', "frame");
});

Deno.test("line frames stop at the first newline and need one to complete", async () => {
  assertEqual(await readLineFrame(chunkedReader([bytes('{"a":1}\n{"b":2}\n')]), 1024), '{"a":1}', "frame");
  assertEqual(await readLineFrame(chunkedReader([bytes('{"a":1}')]), 1024), null, "unterminated frame");
});

Deno.test("line frames are bounded by bytes and must be UTF-8", async () => {
  const big = [bytes("x".repeat(600)), bytes("x".repeat(600)), bytes("\n")];
  await assertRejects(readLineFrame(chunkedReader(big), 1000), (e) => e instanceof FrameError, "oversized frame");
  const invalid = [Uint8Array.of(0x22, 0xc3, 0x22, 0x0a)];
  await assertRejects(readLineFrame(chunkedReader(invalid), 1000), (e) => e instanceof FrameError, "bad UTF-8");
});

Deno.test("writeAll continues after partial writes and stops on zero-length writes", async () => {
  const written: number[] = [];
  const data = bytes("0123456789");
  await writeAll((chunk) => {
    const n = Math.min(3, chunk.length);
    written.push(...chunk.subarray(0, n));
    return Promise.resolve(n);
  }, data);
  assertEqual(written, [...data], "written bytes");
  await assertRejects(writeAll(() => Promise.resolve(0), data), (e) => e instanceof FrameError, "stalled write");
});

// --- DevTools pipe -------------------------------------------------------------------------------

Deno.test("pipe shell wiring is constant and passes argv without expansion", () => {
  const bin = "/Applications/Odd $(name) `x`.app/Contents/MacOS/Odd $HOME";
  const args = ["--user-data-dir=/tmp/a b;c", "--remote-debugging-pipe"];
  assertEqual(pipeShellArgs(bin, args), ["-c", PIPE_SCRIPT, "sh", bin, ...args], "shell argv");
  assertEqual(PIPE_SCRIPT, 'exec "$@" 3<&0 4>&1 </dev/null >/dev/null', "shell script");
});

Deno.test("pipe commands are NUL-terminated JSON", () => {
  const encoded = encodePipeCommand({ id: 1, method: "Test.method", params: { path: "/x" } });
  assertEqual(encoded.at(-1), 0, "terminator");
  assertEqual(JSON.parse(new TextDecoder().decode(encoded.subarray(0, -1))).method, "Test.method", "method");
});

Deno.test("NUL splitter reassembles split messages and rejects malformed ones", async () => {
  const splitter = new NulJsonSplitter(64);
  const stream = bytes('{"id":1}\0{"method":"E"}\0{"id":"é"}\0');
  const messages = [...stream].flatMap((byte) => splitter.push(Uint8Array.of(byte)));
  assertEqual(messages, [{ id: 1 }, { method: "E" }, { id: "é" }], "messages");

  for (const bad of ["[1]\0", "null\0", "{oops\0", `"${"x".repeat(80)}"\0`]) {
    await assertThrows(() => new NulJsonSplitter(64).push(bytes(bad)), (e) => e instanceof FrameError, bad.slice(0, 8));
  }
});

function streamOf(chunks: string[], close = true) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(bytes(chunk));
      if (close) controller.close();
    },
  }).getReader();
}

const never = new Promise<never>(() => {});

Deno.test("pipe startup waits for the matching reply", async () => {
  const reader = streamOf(['{"method":"Target.event"}\0{"id":2}\0{"id":1,"res', 'ult":{"id":"ext"}}\0']);
  const reply = await awaitPipeResponse(reader, 1, { timeoutMs: 1000, exited: never });
  assertEqual(reply, { id: 1, result: { id: "ext" } }, "reply");
  assertEqual(pipeResponseError(reply), undefined, "error");
  assertEqual(pipeResponseError({ id: 1, error: { message: "nope" } }), "nope", "error message");
  assertEqual(pipeResponseError({ id: 1, error: "weird" }), "DevTools command failed", "fallback error");
});

Deno.test("pipe startup fails on exit, closed pipe, timeout or oversized output", async () => {
  const exited = streamOf([], false);
  await assertRejects(
    awaitPipeResponse(exited, 1, { timeoutMs: 1000, exited: Promise.resolve({ code: 127 }) }),
    (e) => String(e).includes("exited"),
    "browser exit",
  );
  await exited.cancel();

  await assertRejects(
    awaitPipeResponse(streamOf(['{"id":2}\0']), 1, { timeoutMs: 1000, exited: never }),
    (e) => String(e).includes("closed"),
    "closed pipe",
  );

  const silent = streamOf([], false);
  await assertRejects(
    awaitPipeResponse(silent, 1, { timeoutMs: 10, exited: never }),
    (e) => String(e).includes("in time"),
    "timeout",
  );
  await silent.cancel();

  await assertRejects(
    awaitPipeResponse(streamOf(["x".repeat(100)], false), 1, { timeoutMs: 1000, exited: never, maxBytes: 64 }),
    (e) => e instanceof FrameError,
    "oversized output",
  );
});

// --- Browser profile scan ------------------------------------------------------------------------

function profileTree(tree: Record<string, string[] | "denied">, files: string[]): ProfileReader {
  return {
    directories: (path) => {
      const entry = tree[path];
      return entry === "denied" ? null : entry ?? [];
    },
    isFile: (path) => files.includes(path),
  };
}

Deno.test("profile scan skips denied folders and picks the newest version", () => {
  const ext = "/b/Default/Extensions/id";
  const fs = profileTree({
    "/a": "denied",
    "/b": ["Locked", "Default"],
    "/b/Locked/Extensions/id": "denied",
    [ext]: ["1.9.0_0", "1.10.0_0"],
  }, [`${ext}/1.10.0_0/background.js`]);
  assertEqual(findExtensionSource(["/a", "/b"], "id", "background.js", fs), {
    path: `${ext}/1.10.0_0`,
    inaccessible: ["/a", "/b/Locked/Extensions/id"],
  }, "search");
  const older = profileTree({ "/b": ["Default"], [ext]: ["1.9.0_0", "1.10.0_0"] }, [`${ext}/1.9.0_0/background.js`]);
  assertEqual(findExtensionSource(["/b"], "id", "background.js", older).path, `${ext}/1.9.0_0`, "fallback version");
});

Deno.test("profile scan reports a clear failure when nothing is found", () => {
  const result = findExtensionSource(["/a", "/b"], "id", "background.js", profileTree({ "/a": "denied" }, []));
  assertEqual(result, { inaccessible: ["/a"] }, "search");
  const message = missingExtensionMessage(result.inaccessible);
  if (!message.includes("not found") || !message.includes("/a")) throw new Error(`Unclear message: ${message}`);
  assertEqual(missingExtensionMessage([]).includes("permission"), false, "message without denied folders");
});

// --- Singleton lock ------------------------------------------------------------------------------

interface MockLockFile {
  closed: boolean;
  calls: unknown[];
  close(): void;
  tryLockSync?: (exclusive?: boolean) => boolean;
}

/** A lock file whose `tryLockSync` returns `result`, or which lacks it when `"unsupported"`. */
function lockFile(result: boolean | "unsupported"): MockLockFile {
  const file: MockLockFile = {
    closed: false,
    calls: [],
    close() {
      file.closed = true;
    },
  };
  if (result !== "unsupported") {
    const acquired = result;
    file.tryLockSync = (exclusive) => {
      file.calls.push(exclusive);
      return acquired;
    };
  }
  return file;
}

Deno.test("singleton lock is exclusive, non-blocking and keeps the file open", async () => {
  const held = lockFile(true);
  assertEqual(acquireSingletonLock(() => held) === held, true, "returned file");
  assertEqual([held.calls, held.closed], [[true], false], "lock state");

  const busy = lockFile(false);
  await assertThrows(() => acquireSingletonLock(() => busy), (e) => e instanceof AlreadyRunningError, "busy lock");
  assertEqual(busy.closed, true, "busy file closed");

  const unsupported = lockFile("unsupported");
  await assertThrows(() => acquireSingletonLock(() => unsupported), (e) => !(e instanceof AlreadyRunningError), "api");
  assertEqual(unsupported.closed, true, "unsupported file closed");
});

// --- Extension session ---------------------------------------------------------------------------

const TOKEN = "t".repeat(36);
const lookup: Message = { cmd: 4, qid: "q", tabId: 0, frameId: 0, body: {} };

class MockSocket implements BridgeSocket {
  sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;
  failSend = false;
  send(data: string) {
    if (this.failSend) throw new Error("send failed");
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith ??= code ?? 1000;
  }
}

function connect(session: ExtensionSession, token = TOKEN) {
  const socket = new MockSocket();
  const events = session.accept(socket);
  events.message(JSON.stringify({ token }));
  return { socket, events };
}

/** Lets queued request promises reach `socket.send`. */
const flush = () => sleep(0);

Deno.test("only the authenticated socket owns the slot and closes are matched by identity", async () => {
  const session = new ExtensionSession(TOKEN);
  const stranger = new MockSocket();
  const strangerEvents = session.accept(stranger);
  const bridge = connect(session);
  assertEqual(session.connected, true, "connected");

  strangerEvents.closed();
  const intruder = connect(session, "x".repeat(36));
  assertEqual(intruder.socket.closedWith, 4003, "bad token");
  intruder.events.closed();
  const second = connect(session);
  assertEqual(second.socket.closedWith, 4001, "second bridge");
  second.events.closed();
  assertEqual(session.connected, true, "still connected after unrelated closes");

  const reply = session.request(lookup);
  await flush();
  const id = bridge.socket.sent[0].id;
  bridge.events.message(JSON.stringify({ id, data: { STATUS: 0 } }));
  assertEqual(await reply, { id, data: { STATUS: 0 } }, "reply");

  bridge.events.closed();
  assertEqual(session.connected, false, "disconnected");
  await assertRejects(session.request(lookup), (e) => e instanceof SessionUnavailableError, "no bridge");
});

Deno.test("non-object messages are rejected before and after authentication", () => {
  const session = new ExtensionSession(TOKEN);
  for (const data of ["[]", "null", '"token"', "{bad", new ArrayBuffer(1)]) {
    const socket = new MockSocket();
    session.accept(socket).message(data);
    assertEqual(socket.closedWith, 4002, `handshake ${String(data)}`);
  }
  const bridge = connect(session);
  bridge.events.message("[1]");
  assertEqual([bridge.socket.closedWith, session.connected], [4002, false], "authenticated bad message");
});

Deno.test("incomplete handshakes expire and are capped", async () => {
  const session = new ExtensionSession(TOKEN, { handshakeTimeoutMs: 5, maxHandshakes: 2 });
  const slow = [new MockSocket(), new MockSocket()];
  const events = slow.map((socket) => session.accept(socket));
  assertEqual(session.canAccept(), false, "capacity");
  const extra = new MockSocket();
  session.accept(extra);
  assertEqual(extra.closedWith, 4009, "over capacity");

  await sleep(20);
  assertEqual(slow.map((socket) => socket.closedWith), [4008, 4008], "expired handshakes");
  events[0].message(JSON.stringify({ token: TOKEN }));
  assertEqual([session.connected, session.canAccept()], [false, true], "late token ignored");
});

Deno.test("a timed-out request fences the session so delayed replies cannot be misattributed", async () => {
  const session = new ExtensionSession(TOKEN, { requestTimeoutMs: 10 });
  const bridge = connect(session);
  const first = session.request(lookup);
  await assertRejects(first, (e) => String(e).includes("timed out"), "timeout");
  const staleId = bridge.socket.sent[0].id;

  const next = session.request(lookup);
  await assertRejects(next, (e) => e instanceof SessionUnavailableError && String(e).includes("apw start"), "fenced");
  assertEqual(bridge.socket.sent.length, 1, "nothing sent after fence");
  bridge.events.message(JSON.stringify({ id: staleId, data: { STATUS: 0 } }));

  // Reconnecting to the same browser session does not lift the fence.
  bridge.events.closed();
  const again = connect(session);
  await assertRejects(session.request(lookup), (e) => e instanceof SessionUnavailableError, "fenced after reconnect");
  assertEqual(again.socket.sent.length, 0, "nothing sent after reconnect");
});

Deno.test("an interrupted request fences the session and is not replayed", async () => {
  const session = new ExtensionSession(TOKEN);
  const bridge = connect(session);
  const inFlight = assertRejects(session.request(lookup), (e) => String(e).includes("disconnected"), "interrupted");
  const queued = assertRejects(session.request(lookup), (e) => e instanceof SessionUnavailableError, "queued");
  await flush();
  bridge.events.closed();
  await inFlight;
  await queued;

  const again = connect(session);
  await assertRejects(session.request(lookup), (e) => e instanceof SessionUnavailableError, "fenced");
  assertEqual([bridge.socket.sent.length, again.socket.sent.length], [1, 0], "no replay");
});

Deno.test("send failures fence and malformed replies fail only their request", async () => {
  const failing = new ExtensionSession(TOKEN);
  const broken = connect(failing);
  broken.socket.failSend = true;
  await assertRejects(failing.request(lookup), (e) => String(e).includes("send"), "send failure");
  assertEqual(typeof failing.fenceReason, "string", "fenced");

  const session = new ExtensionSession(TOKEN);
  const bridge = connect(session);
  const reply = session.request(lookup);
  await flush();
  const id = bridge.socket.sent[0].id;
  bridge.events.message(JSON.stringify({ id: "other", data: { STATUS: 0 } }));
  bridge.events.message(JSON.stringify({ id, data: "not an object" }));
  await assertRejects(reply, (e) => String(e).includes("Malformed"), "malformed reply");
  assertEqual(session.fenceReason, null, "not fenced");
});
