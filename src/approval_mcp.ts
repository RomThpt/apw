const TOOL_NAME = "open_approved_chrome_tab";
const TOOL = {
  name: TOOL_NAME,
  description: "Ask for Touch ID approval, then open the approved HTTPS origin in Chrome for manual sign-in. " +
    "The user selects the approved account in their password manager. This tool only confirms that Chrome opened.",
  inputSchema: {
    type: "object",
    properties: {
      origin: { type: "string", description: "Exact HTTPS origin, without a path, query, or fragment" },
      account: { type: "string", description: "Exact account identifier to display in the approval prompt" },
    },
    required: ["origin", "account"],
    additionalProperties: false,
  },
};

const FALLBACK_PROTOCOL_VERSION = "2025-11-25";
const PROTOCOL_VERSIONS = [FALLBACK_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_MESSAGE_LENGTH = 8192;
const encoder = new TextEncoder();

const outcomes = {
  browser_opened: 0,
  denied: 1,
  invalid_request: 2,
  unavailable: 3,
  browser_unavailable: 4,
} as const;

type Outcome = keyof typeof outcomes;
type Intent = { origin: string; account: string };
type OpenBrowser = (intent: Intent) => Promise<Outcome>;
type Id = string | number | null;

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function failure(id: Id, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function createApprovalServer(openBrowser: OpenBrowser) {
  let initialized = false;
  let opening = false;

  return async (line: string) => {
    let request;
    try {
      request = asObject(JSON.parse(line));
    } catch {
      return failure(null, -32700, "Parse error");
    }

    const id = request.id;
    const method = request.method;
    if (request.jsonrpc !== "2.0" || typeof method !== "string") {
      return failure(null, -32600, "Invalid request");
    }
    if (id === undefined) return;
    if (typeof id !== "string" && typeof id !== "number") {
      return failure(null, -32600, "Invalid request ID");
    }

    const params = asObject(request.params);
    const success = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      const requested = params.protocolVersion;
      if (initialized || typeof requested !== "string") return failure(id, -32602, "Invalid initialization");
      initialized = true;
      return success({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "apw-browser-approval", version: "0.1.0" },
      });
    }
    if (method === "ping") return success({});
    if (!initialized) return failure(id, -32000, "Server not initialized");
    if (method === "tools/list") return success({ tools: [TOOL] });
    if (method !== "tools/call") return failure(id, -32601, "Method not found");
    if (params.name !== TOOL_NAME) return failure(id, -32602, "Unknown tool");

    const args = asObject(params.arguments);
    if (Object.keys(args).length !== 2 || typeof args.origin !== "string" || typeof args.account !== "string") {
      return failure(id, -32602, "Expected only origin and account strings");
    }
    if (opening) return failure(id, -32000, "An approval request is already in progress");
    opening = true;
    let outcome: Outcome = "unavailable";
    try {
      outcome = await openBrowser({ origin: args.origin, account: args.account });
    } catch {
      // Native failures may contain identifying details. The client only receives a fixed outcome.
    } finally {
      opening = false;
    }
    return success({
      content: [{ type: "text", text: JSON.stringify({ outcome }) }],
      isError: outcome !== "browser_opened",
    });
  };
}

export function decodeNativeOutcome(output: Uint8Array, code: number): Outcome {
  const text = new TextDecoder().decode(output);
  for (const [outcome, exitCode] of Object.entries(outcomes)) {
    if (code === exitCode && text === `${JSON.stringify({ outcome })}\n`) return outcome as Outcome;
  }
  return "unavailable";
}

async function openWithNativeHelper(helper: string, intent: Intent): Promise<Outcome> {
  const child = new Deno.Command(helper, {
    args: ["--open-chrome"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const input = child.stdin.getWriter();
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // The helper may have exited while the timer was being cleared.
    }
  }, 45_000);
  try {
    const request = encoder.encode(JSON.stringify(intent));
    const [result] = await Promise.all([child.output(), input.write(request).then(() => input.close())]);
    return decodeNativeOutcome(result.stdout, result.code);
  } finally {
    clearTimeout(timer);
  }
}

async function serve(openBrowser: OpenBrowser) {
  const handle = createApprovalServer(openBrowser);
  const output = Deno.stdout.writable.getWriter();
  const pending = new Set<Promise<void>>();
  let buffer = "";
  for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream("utf-8", { fatal: true }))) {
    for (const [index, line] of chunk.split("\n").entries()) {
      if (index > 0) {
        const response = handle(buffer).then(async (result) => {
          if (result) await output.write(encoder.encode(`${JSON.stringify(result)}\n`));
        });
        pending.add(response);
        void response.then(() => pending.delete(response), () => pending.delete(response));
        buffer = "";
      }
      buffer += line;
      if (buffer.length > MAX_MESSAGE_LENGTH) throw new Error("Request too large");
    }
  }
  await Promise.all(pending);
}

if (import.meta.main) {
  const [helper, ...extra] = Deno.args;
  if (!helper?.startsWith("/") || extra.length) {
    console.error("Expected the absolute path to signin-approval-harness");
    Deno.exit(2);
  }
  try {
    await serve((intent) => openWithNativeHelper(helper, intent));
  } catch {
    console.error("Approval server stopped");
    Deno.exit(1);
  }
}
