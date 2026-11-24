// Tracks the WebSocket bridge running inside the managed browser's extension.
//
// - Sockets must authenticate with the token before they can carry requests; only one
//   authenticated socket owns the active slot, and every close is matched by socket identity.
// - Requests are serialized. The bridge keeps a single pending slot and matches Apple's replies by
//   command only, so a reply that arrives after we gave up could be attributed to the next request.
//   After a timeout or an interrupted request the session is therefore fenced: further requests
//   fail until the daemon is restarted. Requests are never replayed automatically.

import type { APWResponse, Message } from "./types.ts";
import { isRecord } from "./framing.ts";

export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface BridgeEvents {
  message(data: unknown): void;
  closed(): void;
}

/** The session cannot serve requests (no authenticated bridge, or fenced). */
export class SessionUnavailableError extends Error {}

export const RESTART_HINT = "restart APW with `apw start` before retrying";

interface Pending {
  id: string;
  resolve: (value: APWResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SessionOptions {
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxHandshakes?: number;
}

function tokenMatches(value: unknown, token: string): boolean {
  if (typeof value !== "string" || value.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= value.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

function parseObject(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    const value = JSON.parse(data);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isResponse(message: Record<string, unknown>): message is APWResponse {
  if (typeof message.id !== "string") return false;
  if ("data" in message) return isRecord(message.data);
  return typeof message.status === "number" && (message.error === undefined || typeof message.error === "string");
}

function closeQuietly(socket: BridgeSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closing.
  }
}

export class ExtensionSession {
  private active: BridgeSocket | null = null;
  private handshakes = new Map<BridgeSocket, ReturnType<typeof setTimeout>>();
  private pending: Pending | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private fenced: string | null = null;
  private requestTimeoutMs: number;
  private handshakeTimeoutMs: number;
  private maxHandshakes: number;

  constructor(private token: string, options: SessionOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.maxHandshakes = options.maxHandshakes ?? 4;
  }

  get connected(): boolean {
    return this.active !== null;
  }

  get fenceReason(): string | null {
    return this.fenced;
  }

  /** Whether another unauthenticated socket may be accepted right now. */
  canAccept(): boolean {
    return this.handshakes.size < this.maxHandshakes;
  }

  accept(socket: BridgeSocket): BridgeEvents {
    if (this.canAccept()) {
      const timer = setTimeout(() => this.drop(socket, 4008, "Handshake timed out"), this.handshakeTimeoutMs);
      this.handshakes.set(socket, timer);
    } else {
      closeQuietly(socket, 4009, "Too many pending connections");
    }
    return {
      message: (data) => this.onMessage(socket, data),
      closed: () => this.release(socket),
    };
  }

  request(message: Message): Promise<APWResponse> {
    const result = this.chain.then(() => this.send(message));
    this.chain = result.catch(() => {});
    return result;
  }

  private onMessage(socket: BridgeSocket, data: unknown): void {
    const message = parseObject(data);
    if (socket === this.active) {
      if (!message) return this.drop(socket, 4002, "Bad message");
      this.onReply(message);
      return;
    }
    if (!this.handshakes.has(socket)) return;
    this.endHandshake(socket);
    if (!message) return this.drop(socket, 4002, "Bad message");
    if (!tokenMatches(message.token, this.token)) return this.drop(socket, 4003, "Unauthorized");
    if (this.active) return this.drop(socket, 4001, "Already connected");
    this.active = socket;
    console.info("[apw] extension connected");
  }

  private onReply(message: Record<string, unknown>): void {
    const pending = this.pending;
    if (!pending || message.id !== pending.id) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (isResponse(message)) pending.resolve(message);
    else pending.reject(new Error("Malformed response from extension"));
  }

  private send(message: Message): Promise<APWResponse> {
    if (this.fenced) throw new SessionUnavailableError(`${this.fenced}; ${RESTART_HINT}`);
    const socket = this.active;
    if (!socket) throw new SessionUnavailableError();
    return new Promise<APWResponse>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => this.fence("Extension response timed out"), this.requestTimeoutMs);
      this.pending = { id, resolve, reject, timer };
      try {
        socket.send(JSON.stringify({ ...message, id }));
      } catch {
        this.fence("Could not send request to extension");
      }
    });
  }

  /** Marks the session unusable and fails the in-flight request. */
  private fence(reason: string): void {
    this.fenced ??= reason;
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(new Error(`${reason}; ${RESTART_HINT}`));
  }

  private endHandshake(socket: BridgeSocket): void {
    const timer = this.handshakes.get(socket);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.handshakes.delete(socket);
  }

  private drop(socket: BridgeSocket, code: number, reason: string): void {
    this.release(socket);
    closeQuietly(socket, code, reason);
  }

  private release(socket: BridgeSocket): void {
    this.endHandshake(socket);
    if (socket !== this.active) return;
    this.active = null;
    if (this.pending) this.fence("Extension disconnected during a request");
    console.info("[apw] extension disconnected");
  }
}
