import { APWError, DATA_PATH, SOCKET_PATH, Status } from "./const.ts";
import { type Browser, launchBrowser } from "./browser.ts";
import { acquireSingletonLock, AlreadyRunningError } from "./daemon_lock.ts";
import { ExtensionSession, SessionUnavailableError } from "./extension_session.ts";
import { FrameError, isRecord, readLineFrame, writeAll } from "./framing.ts";
import type { APWResponse, Message } from "./types.ts";

const READ_TIMEOUT_MS = 30_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const LOCK_PATH = `${DATA_PATH}/daemon.lock`;

// Held open for the daemon's lifetime; the OS releases the lock when the process exits.
let daemonLock: Deno.FsFile | undefined;

const encoder = new TextEncoder();

function closeQuietly(conn: Deno.Conn): void {
  try {
    conn.close();
  } catch {
    // Already closed.
  }
}

function isDisconnect(error: unknown): boolean {
  return error instanceof Deno.errors.BrokenPipe ||
    error instanceof Deno.errors.ConnectionReset ||
    error instanceof Deno.errors.BadResource ||
    error instanceof Deno.errors.Interrupted;
}

function failure(error: unknown): APWResponse {
  const status = error instanceof APWError
    ? error.status
    : error instanceof SessionUnavailableError
    ? Status.INVALID_SESSION
    : Status.SERVER_ERROR;
  const message = (error instanceof Error ? error.message : undefined) || new APWError(status).message;
  return { id: "", status, error: message };
}

function parseRequest(line: string): Message {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    throw new APWError(Status.INVALID_PARAM);
  }
  if (!isRecord(message) || typeof message.cmd !== "number") throw new APWError(Status.INVALID_PARAM);
  return message as Message;
}

async function respond(conn: Deno.Conn, session: ExtensionSession): Promise<APWResponse | null> {
  let line: string | null;
  const deadline = setTimeout(() => closeQuietly(conn), READ_TIMEOUT_MS);
  try {
    line = await readLineFrame((buffer) => conn.read(buffer), MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof FrameError) return failure(new APWError(Status.INVALID_PARAM, error.message));
    throw error;
  } finally {
    clearTimeout(deadline);
  }
  if (line === null) return null;

  try {
    return await session.request(parseRequest(line));
  } catch (error) {
    return failure(error);
  }
}

async function handleCliConnection(conn: Deno.Conn, session: ExtensionSession): Promise<void> {
  try {
    const response = await respond(conn, session);
    if (response) {
      await writeAll((data) => conn.write(data), encoder.encode(`${JSON.stringify(response)}\n`));
    }
  } catch (error) {
    if (!isDisconnect(error)) console.error(error);
  } finally {
    closeQuietly(conn);
  }
}

function lockDaemon(): void {
  try {
    daemonLock = acquireSingletonLock(() =>
      Deno.openSync(LOCK_PATH, { read: true, write: true, create: true, mode: 0o600 })
    );
  } catch (error) {
    if (error instanceof AlreadyRunningError) {
      throw new APWError(Status.GENERIC_ERROR, "APW is already running. Stop the other `apw start` first.");
    }
    throw error;
  }
}

/** Leave an existing daemon alone, including older builds that do not take the lock. */
async function clearStaleSocket(): Promise<void> {
  try {
    if (!Deno.lstatSync(SOCKET_PATH).isSocket) {
      throw new APWError(Status.GENERIC_ERROR, "Refusing to replace a non-socket at the daemon socket path.");
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }

  try {
    const connection = await Deno.connect({ transport: "unix", path: SOCKET_PATH });
    closeQuietly(connection);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    if (!(error instanceof Deno.errors.ConnectionRefused)) throw error;
    Deno.removeSync(SOCKET_PATH);
    return;
  }
  throw new APWError(Status.GENERIC_ERROR, "APW is already running. Stop the other `apw start` first.");
}

export async function daemon(browser: Browser): Promise<void> {
  Deno.mkdirSync(DATA_PATH, { recursive: true, mode: 0o700 });
  Deno.chmodSync(DATA_PATH, 0o700);
  // Taken before touching the managed extension, browser profile or socket.
  lockDaemon();
  await clearStaleSocket();

  const token = crypto.randomUUID();
  const session = new ExtensionSession(token);

  const wsServer = Deno.serve({ hostname: "127.0.0.1", port: 0 }, (req) => {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    if (!session.canAccept()) return new Response("Too many pending connections", { status: 503 });
    const { socket, response } = Deno.upgradeWebSocket(req);
    const bridge = session.accept(socket);
    socket.onmessage = (event) => bridge.message(event.data);
    socket.onclose = () => bridge.closed();
    return response;
  });

  const child = await launchBrowser(browser, { port: (wsServer.addr as Deno.NetAddr).port, token });
  console.info(`[apw] launched headless ${browser.name}; extension loaded.`);

  let stopping = false;
  const shutdown = async () => {
    stopping = true;
    try {
      child.kill("SIGTERM");
      await child.status;
    } catch { /* ignore */ }
    daemonLock?.close();
    Deno.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) Deno.addSignalListener(signal, shutdown);
  child.status.then((status) => {
    if (stopping) return;
    console.error(`[apw] ${browser.name} exited unexpectedly (code ${status.code}); run \`apw start\` again.`);
    Deno.exit(1);
  });

  const unixListener = Deno.listen({ transport: "unix", path: SOCKET_PATH });
  console.info(`[apw] Unix socket at ${SOCKET_PATH}`);
  await Deno.chmod(SOCKET_PATH, 0o600);

  for await (const conn of unixListener) {
    handleCliConnection(conn, session);
  }
}
