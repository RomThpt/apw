import { createApprovalServer, decodeNativeOutcome } from "./approval_mcp.ts";

const tool = "open_approved_chrome_tab";
const origin = "https://login.example.test";
const account = "demo@example.test";

function assertEqual(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Unexpected approval server response");
  }
}

function request(method: string, params: unknown = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
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
