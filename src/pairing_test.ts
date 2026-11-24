import { APWError, Status } from "./const.ts";
import { confirmPairing, PAIRING_UNCONFIRMED, PAIRING_UNSUPPORTED, pairingStateFrom } from "./pairing.ts";
import type { APWResponse } from "./types.ts";

function assertEqual(actual: unknown, expected: unknown, message = "Unexpected value") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

async function assertRejectsWith(promise: Promise<unknown>, status: Status, message: string) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof APWError && error.status === status && error.message === message) return;
    throw new Error("Rejected with an unexpected error");
  }
  throw new Error("Expected a rejection");
}

const ok = (paired?: boolean): APWResponse =>
  paired === undefined ? { id: "x", status: Status.SUCCESS } : { id: "x", status: Status.SUCCESS, paired };

/** Fake clock: `sleep` advances time instantly so polling tests run without real timers. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: (ms: number) => {
      time += ms;
      return Promise.resolve();
    },
  };
}

/** Returns the given replies in order, then repeats the last one; counts queries. */
function scripted(...replies: Array<APWResponse | Error>) {
  const fn = () => {
    const reply = replies[Math.min(fn.calls++, replies.length - 1)];
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  fn.calls = 0;
  return fn;
}

Deno.test("maps handshake replies to pairing states", () => {
  assertEqual(pairingStateFrom(ok(true)), "paired");
  assertEqual(pairingStateFrom(ok(false)), "pending");
  assertEqual(pairingStateFrom(ok()), "unsupported");
  assertEqual(pairingStateFrom({ id: "x", status: Status.SUCCESS, paired: "yes" }), "error");
  assertEqual(pairingStateFrom({ id: "x", status: Status.INVALID_SESSION, paired: true }), "error");
  assertEqual(pairingStateFrom({ id: "x", data: { STATUS: 0 } }), "error");
  assertEqual(pairingStateFrom(null), "error");
  assertEqual(pairingStateFrom("paired"), "error");
});

Deno.test("confirms once the bridge reports an established session", async () => {
  const clock = fakeClock();
  const query = scripted(ok(false), ok(false), ok(true));
  await confirmPairing(ok(false), query, clock);
  assertEqual(query.calls, 3);
});

Deno.test("confirms immediately when the submission reply is already paired", async () => {
  const query = scripted(ok(false));
  await confirmPairing(ok(true), query, fakeClock());
  assertEqual(query.calls, 0);
});

Deno.test("never queries a bridge without status support", async () => {
  const query = scripted(ok(true));
  await assertRejectsWith(confirmPairing(ok(), query, fakeClock()), Status.INVALID_SESSION, PAIRING_UNSUPPORTED);
  assertEqual(query.calls, 0);
});

Deno.test("reports unconfirmed after a bounded wait", async () => {
  const clock = fakeClock();
  const query = scripted(ok(false));
  const options = { ...clock, timeoutMs: 1000, intervalMs: 100 };
  await assertRejectsWith(confirmPairing(ok(false), query, options), Status.INVALID_SESSION, PAIRING_UNCONFIRMED);
  assertEqual(query.calls, 10);
  assertEqual(clock.now(), 1000);
});

Deno.test("bounds the number of queries even if the clock does not advance", async () => {
  const query = scripted(ok(false));
  const options = { now: () => 0, sleep: () => Promise.resolve(), timeoutMs: 1000, intervalMs: 250 };
  await assertRejectsWith(confirmPairing(ok(false), query, options), Status.INVALID_SESSION, PAIRING_UNCONFIRMED);
  assertEqual(query.calls, 4);
});

Deno.test("stops polling and reports unconfirmed on a failed or malformed status reply", async () => {
  const failures: Array<APWResponse | Error> = [
    new APWError(Status.INVALID_SESSION),
    new Error("connection reset"),
    { id: "x", status: Status.SERVER_ERROR, error: "handshake failed" },
    ok(),
  ];
  for (const failure of failures) {
    const query = scripted(ok(false), failure, ok(true));
    await assertRejectsWith(confirmPairing(ok(false), query, fakeClock()), Status.INVALID_SESSION, PAIRING_UNCONFIRMED);
    assertEqual(query.calls, 2);
  }
});

Deno.test("treats a failed submission reply as unconfirmed without polling", async () => {
  const query = scripted(ok(true));
  const submission = { id: "x", status: Status.SERVER_ERROR, error: "handshake failed" } as APWResponse;
  await assertRejectsWith(confirmPairing(submission, query, fakeClock()), Status.INVALID_SESSION, PAIRING_UNCONFIRMED);
  assertEqual(query.calls, 0);
});
