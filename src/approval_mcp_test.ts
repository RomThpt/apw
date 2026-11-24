import { createApprovalServer, decodeNativeOutcome, serve } from "./approval_mcp.ts";

type Outcome = "browser_opened" | "denied" | "invalid_request" | "unavailable" | "browser_unavailable";

const tool = "open_approved_chrome_tab";
const origin = "https://login.example.test";
const account = "demo@example.test";

function assertEqual(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Unexpected approval server response");
  }
}

function request(method: string, params: unknown = {}, id: string | number = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function cancel(requestId: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "test" } });
}

function call(id: string | number) {
  return request("tools/call", { name: tool, arguments: { origin, account } }, id);
}

function outcomeResult(id: string | number, outcome: Outcome) {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify({ outcome }) }], isError: outcome !== "browser_opened" },
  };
}

// A synthetic opener that records each abort signal and settles only when the test says so, standing in for the
// native helper without spawning anything.
function fakeOpener() {
  const calls: { signal: AbortSignal; finish: (outcome: Outcome) => void; fail: () => void }[] = [];
  const open = (_intent: unknown, signal: AbortSignal) => {
    const { promise, resolve, reject } = Promise.withResolvers<Outcome>();
    calls.push({ signal, finish: resolve, fail: () => reject(new Error("synthetic private detail")) });
    return promise;
  };
  return { calls, open };
}

const initialize = request("initialize", { protocolVersion: "2025-06-18" });
const open = request("tools/call", { name: tool, arguments: { origin, account } });

Deno.test("exposes only the Chrome handoff and reports an opened browser", async () => {
  const server = createApprovalServer((intent) => {
    assertEqual(intent, { origin, account });
    return Promise.resolve("browser_opened");
  });
  const handshake = await server(initialize);
  assertEqual(handshake && "result" in handshake && handshake.result, {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "apw-browser-approval", version: "0.1.0" },
  });
  const listing = await server(request("tools/list"));
  if (!JSON.stringify(listing).includes(tool)) throw new Error("Missing handoff tool");
  const result = await server(open);
  assertEqual(result && "result" in result && result.result, {
    content: [{ type: "text", text: '{"outcome":"browser_opened"}' }],
    isError: false,
  });
});

Deno.test("rejects unknown operations, missing initialization and rejected approvals", async () => {
  let calls = 0;
  const server = createApprovalServer(() => {
    calls++;
    return Promise.resolve("denied");
  });
  const uninitialized = await server(open);
  assertEqual(uninitialized && "error" in uninitialized && uninitialized.error.code, -32000);
  await server(initialize);
  for (
    const params of [
      { name: "get_password", arguments: { origin, account } },
      { name: tool, arguments: { origin, account, command: "unused" } },
      { name: tool, arguments: { origin } },
    ]
  ) {
    const result = await server(request("tools/call", params));
    assertEqual(result && "error" in result && result.error.code, -32602);
  }
  assertEqual(calls, 0);
  const result = await server(open);
  assertEqual(result && "result" in result && result.result, {
    content: [{ type: "text", text: '{"outcome":"denied"}' }],
    isError: true,
  });
  assertEqual(calls, 1);
});

Deno.test("allows only one approval prompt at a time", async () => {
  const finish = Promise.withResolvers<"unavailable">();
  const server = createApprovalServer(() => finish.promise);
  await server(initialize);
  const pending = server(open);
  const overlapping = await server(request("tools/call", { name: tool, arguments: { origin, account } }, 2));
  assertEqual(overlapping && "error" in overlapping && overlapping.error.code, -32000);
  finish.resolve("unavailable");
  await pending;
});

Deno.test("never forwards unexpected native output or error text", async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  assertEqual(decodeNativeOutcome(encode('{"outcome":"browser_opened"}\n'), 0), "browser_opened");
  assertEqual(decodeNativeOutcome(encode('{"outcome":"browser_opened"}\n'), 1), "unavailable");
  assertEqual(decodeNativeOutcome(encode('{"outcome":"browser_unavailable"}\n'), 4), "browser_unavailable");
  assertEqual(decodeNativeOutcome(encode('{"outcome":"browser_opened","x":"mock"}\n'), 0), "unavailable");
  const server = createApprovalServer(() => Promise.reject(new Error("synthetic private detail")));
  await server(initialize);
  if (JSON.stringify(await server(open)).includes("synthetic private detail")) {
    throw new Error("Native error detail leaked");
  }
});

Deno.test("cancels only the matching numeric request ID and suppresses its reply", async () => {
  const opener = fakeOpener();
  const server = createApprovalServer(opener.open);
  await server(initialize);
  const pending = server(call(7));
  const { signal, finish } = opener.calls[0];
  for (const requestId of ["7", 8, null, undefined]) {
    assertEqual(await server(cancel(requestId)), undefined);
    assertEqual(signal.aborted, false);
  }
  assertEqual(await server(cancel(7)), undefined);
  assertEqual(signal.aborted, true);

  // The slot stays held until the opener has settled, even though the request was canceled.
  const overlapping = await server(call(9));
  assertEqual(overlapping && "error" in overlapping && overlapping.error.code, -32000);
  assertEqual(opener.calls.length, 1);

  // A late result from the canceled opener is never sent, even a successful handoff.
  finish("browser_opened");
  assertEqual(await pending, undefined);

  // After cleanup the slot is free again, and the same ID can be reused.
  const reused = server(call(7));
  assertEqual(opener.calls.length, 2);
  assertEqual(opener.calls[1].signal.aborted, false);
  opener.calls[1].finish("denied");
  assertEqual(await reused, outcomeResult(7, "denied"));
});

Deno.test("cancels a string request ID only with the identical string", async () => {
  const opener = fakeOpener();
  const server = createApprovalServer(opener.open);
  await server(initialize);
  const pending = server(call("1"));
  const { signal, fail } = opener.calls[0];
  await server(cancel(1));
  assertEqual(signal.aborted, false);
  await server(cancel("01"));
  assertEqual(signal.aborted, false);
  await server(cancel("1"));
  assertEqual(signal.aborted, true);

  // A canceled opener that fails is also silent and still releases the slot.
  fail();
  assertEqual(await pending, undefined);
  const next = server(call(1));
  opener.calls[1].finish("browser_opened");
  assertEqual(await next, outcomeResult(1, "browser_opened"));
});

Deno.test("ignores cancellation when nothing matching is in flight", async () => {
  const opener = fakeOpener();
  const server = createApprovalServer(opener.open);
  await server(initialize);
  assertEqual(await server(cancel(1)), undefined);
  // Canceling a request that has already completed does not affect the next one.
  const first = server(call(1));
  opener.calls[0].finish("denied");
  assertEqual(await first, outcomeResult(1, "denied"));
  assertEqual(await server(cancel(1)), undefined);
  const second = server(call(2));
  assertEqual(opener.calls[1].signal.aborted, false);
  opener.calls[1].finish("browser_unavailable");
  assertEqual(await second, outcomeResult(2, "browser_unavailable"));
});

Deno.test("never reports an outcome outside the fixed set", async () => {
  const server = createApprovalServer(() => Promise.resolve("token" as unknown as Outcome));
  await server(initialize);
  assertEqual(await server(open), outcomeResult(1, "unavailable"));
});

// Synthetic stdio: the test pushes input chunks and ends the input explicitly, the output collects replies.
function transport() {
  let control!: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({ start: (controller) => void (control = controller) });
  const push = (chunk: string | Uint8Array) =>
    control.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  const end = () => control.close();
  const written: string[] = [];
  const decoder = new TextDecoder();
  const output = new WritableStream<Uint8Array>({ write: (chunk) => void written.push(decoder.decode(chunk)) });
  const replies = () => written.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { input, output, push, end, replies };
}

// Opener that reports when it starts and when it is aborted, and settles only when the test releases it.
function heldOpener() {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Outcome>();
  const state = { settled: false };
  const open = (_intent: unknown, signal: AbortSignal) => {
    started.resolve();
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return release.promise.finally(() => {
      state.settled = true;
    });
  };
  return { started: started.promise, aborted: aborted.promise, release: release.resolve, state, open };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("stdio transport answers requests and drains before returning", async () => {
  const { input, output, push, end, replies } = transport();
  push(`${initialize}\n${call(3)}\n`);
  end();
  await serve(() => Promise.resolve("browser_opened"), input, output);
  const [handshake, result] = replies();
  assertEqual(handshake.id, 1);
  assertEqual(result, outcomeResult(3, "browser_opened"));
});

Deno.test("stdin EOF aborts the in-flight approval and waits for it to settle", async () => {
  const opener = heldOpener();
  const { input, output, push, end, replies } = transport();
  let returned = false;
  const served = serve(opener.open, input, output).then(() => {
    returned = true;
  });
  push(`${initialize}\n${call(4)}\n`);
  await opener.started;
  end();
  await opener.aborted;
  await tick();
  assertEqual(returned, false);
  opener.release("browser_opened");
  await served;
  assertEqual(opener.state.settled, true);
  // Only the handshake is answered. The disconnected call receives nothing.
  assertEqual(replies().map((reply) => reply.id), [1]);
});

Deno.test("malformed input aborts the in-flight approval before failing", async () => {
  const opener = heldOpener();
  const { input, output, push } = transport();
  let failed = false;
  const served = serve(opener.open, input, output).catch(() => {
    failed = true;
  });
  push(`${initialize}\n${call(5)}\n`);
  await opener.started;
  // Invalid UTF-8 makes the transport fail, which must still stop the in-flight approval first.
  push(new Uint8Array([0xff, 0x0a]));
  await opener.aborted;
  await tick();
  assertEqual(failed, false);
  opener.release("denied");
  await served;
  assertEqual(failed, true);
  assertEqual(opener.state.settled, true);
});
