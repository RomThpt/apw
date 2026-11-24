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
// The signal aborts when the client cancels the call or disconnects. Openers must settle only after any native work they
// started has fully stopped, because the server keeps the single approval slot until then.
type OpenBrowser = (intent: Intent, signal: AbortSignal) => Promise<Outcome>;
type Id = string | number | null;
type Active = { id: string | number; controller: AbortController; canceled: boolean };

const NATIVE_TIMEOUT_MS = 45_000;
const NATIVE_KILL_GRACE_MS = 2_000;

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
  // The in-flight approval, if any. It stays set until the opener settles, even after cancellation, so a new prompt
  // cannot start while a canceled native helper is still running.
  let active: Active | undefined;
  let settled: Promise<void> = Promise.resolve();

  const cancelActive = () => {
    if (!active) return;
    active.canceled = true;
    active.controller.abort();
  };

  const handle = async (line: string) => {
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
    const params = asObject(request.params);
    if (id === undefined) {
      // Strict equality keeps string and numeric IDs distinct: "1" never cancels request 1. Cancellation only stops
      // local work and suppresses the reply. It cannot undo a Chrome handoff that macOS has already accepted.
      if (method === "notifications/cancelled" && active && params.requestId === active.id) cancelActive();
      return;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      return failure(null, -32600, "Invalid request ID");
    }

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
    if (active) return failure(id, -32000, "An approval request is already in progress");
    const current: Active = { id, controller: new AbortController(), canceled: false };
    active = current;
    const done = Promise.withResolvers<void>();
    settled = done.promise;
    let outcome: Outcome = "unavailable";
    try {
      const result = await openBrowser({ origin: args.origin, account: args.account }, current.controller.signal);
      if (Object.hasOwn(outcomes, result)) outcome = result;
    } catch {
      // Native failures may contain identifying details. The client only receives a fixed outcome.
    } finally {
      active = undefined;
      done.resolve();
    }
    // The client has abandoned a canceled request, so it receives no response.
    if (current.canceled) return;
    return success({
      content: [{ type: "text", text: JSON.stringify({ outcome }) }],
      isError: outcome !== "browser_opened",
    });
  };

  // Called when the transport closes: cancel the in-flight approval and wait until its opener has settled.
  const close = () => {
    cancelActive();
    return settled;
  };

  return Object.assign(handle, { close });
}

export function decodeNativeOutcome(output: Uint8Array, code: number): Outcome {
  const text = new TextDecoder().decode(output);
  for (const [outcome, exitCode] of Object.entries(outcomes)) {
    if (code === exitCode && text === `${JSON.stringify({ outcome })}\n`) return outcome as Outcome;
  }
  return "unavailable";
}

// Runs the native helper once. On cancellation or timeout the helper receives SIGTERM, then SIGKILL after a grace
// period, and the promise settles only after the process has exited and been reaped. A stopped helper always maps to
// "unavailable", even if it finished at the same moment, because its output can no longer be trusted as complete.
// Stopping the helper cannot undo a Chrome handoff that macOS already accepted. Native output is never logged.
async function openWithNativeHelper(helper: string, intent: Intent, signal: AbortSignal): Promise<Outcome> {
  if (signal.aborted) return "unavailable";
  const child = new Deno.Command(helper, {
    args: ["--open-chrome"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  let stopped = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const send = (name: Deno.Signal) => {
    try {
      child.kill(name);
    } catch {
      // The helper may already have exited.
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    send("SIGTERM");
    killTimer = setTimeout(() => send("SIGKILL"), NATIVE_KILL_GRACE_MS);
  };
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, NATIVE_TIMEOUT_MS);
  const writeRequest = async () => {
    const input = child.stdin.getWriter();
    try {
      await input.write(encoder.encode(JSON.stringify(intent)));
      await input.close();
    } catch {
      // A helper that exits early closes its stdin. Its exit status decides the outcome.
    }
  };
  try {
    // output() resolves only after the process has exited, so the helper is always reaped before this returns.
    const [result] = await Promise.all([child.output(), writeRequest()]);
    if (stopped) return "unavailable";
    return decodeNativeOutcome(result.stdout, result.code);
  } catch {
    stop();
    await child.status.catch(() => {});
    return "unavailable";
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal.removeEventListener("abort", stop);
  }
}

// Serves newline-delimited JSON-RPC over the given streams. When the input ends or fails, the in-flight approval is
// canceled and this waits for it to settle before returning.
export async function serve(
  openBrowser: OpenBrowser,
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
) {
  const handle = createApprovalServer(openBrowser);
  const writer = output.getWriter();
  const pending = new Set<Promise<void>>();
  let buffer = "";
  try {
    for await (const chunk of input.pipeThrough(new TextDecoderStream("utf-8", { fatal: true }))) {
      for (const [index, line] of chunk.split("\n").entries()) {
        if (index > 0) {
          const response = handle(buffer).then(async (result) => {
            if (result) await writer.write(encoder.encode(`${JSON.stringify(result)}\n`));
          });
          pending.add(response);
          void response.then(() => pending.delete(response), () => pending.delete(response));
          buffer = "";
        }
        buffer += line;
        if (buffer.length > MAX_MESSAGE_LENGTH) throw new Error("Request too large");
      }
    }
  } finally {
    await handle.close();
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
    await serve(
      (intent, signal) => openWithNativeHelper(helper, intent, signal),
      Deno.stdin.readable,
      Deno.stdout.writable,
    );
  } catch {
    console.error("Approval server stopped");
    Deno.exit(1);
  }
}
