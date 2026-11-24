import { APWError, Status } from "./const.ts";
import type { APWResponse } from "./types.ts";

/**
 * Pairing state as reported by the extension bridge on a HANDSHAKE reply.
 *
 * - `paired`: the bridge reports its existing session state as established.
 * - `pending`: the bridge supports status reporting but the session is not established yet.
 * - `unsupported`: the reply carries no pairing field, e.g. a daemon started from an older build.
 * - `error`: the reply is malformed or reports a failure.
 */
export type PairingState = "paired" | "pending" | "unsupported" | "error";

export const PAIRING_UNCONFIRMED =
  "Pairing was not confirmed. The PIN may be invalid or expired; run `apw auth` again.";
export const PAIRING_UNSUPPORTED =
  "The running daemon cannot confirm pairing. Restart it with `apw start`, then run `apw auth` again.";

export const PAIRING_TIMEOUT_MS = 5_000;
export const PAIRING_INTERVAL_MS = 250;

export function pairingStateFrom(response: unknown): PairingState {
  if (!response || typeof response !== "object" || "data" in response) return "error";
  const { status, paired } = response as { status?: unknown; paired?: unknown };
  if (status !== Status.SUCCESS) return "error";
  if (paired === true) return "paired";
  if (paired === false) return "pending";
  return paired === undefined ? "unsupported" : "error";
}

export interface PairingWaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolves only once the bridge reports an established session after a PIN submission. `query` must be a read-only
 * status request; it is never issued when the submission reply shows the bridge lacks status support, so an older
 * bridge never receives a message it would treat as a new challenge. Polling stops after `timeoutMs` and at most
 * `ceil(timeoutMs / intervalMs)` queries. Every failure is reported as `INVALID_SESSION` with a stable message.
 */
export async function confirmPairing(
  submission: APWResponse,
  query: () => Promise<APWResponse>,
  options: PairingWaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? PAIRING_TIMEOUT_MS;
  const intervalMs = Math.max(1, options.intervalMs ?? PAIRING_INTERVAL_MS);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const initial = pairingStateFrom(submission);
  if (initial === "paired") return;
  if (initial === "unsupported") throw new APWError(Status.INVALID_SESSION, PAIRING_UNSUPPORTED);
  if (initial === "error") throw new APWError(Status.INVALID_SESSION, PAIRING_UNCONFIRMED);

  const deadline = now() + timeoutMs;
  const maxQueries = Math.ceil(timeoutMs / intervalMs);
  for (let attempt = 0; attempt < maxQueries && now() < deadline; attempt++) {
    await sleep(intervalMs);
    let state: PairingState;
    try {
      state = pairingStateFrom(await query());
    } catch {
      state = "error";
    }
    if (state === "paired") return;
    if (state !== "pending") break;
  }
  throw new APWError(Status.INVALID_SESSION, PAIRING_UNCONFIRMED);
}
