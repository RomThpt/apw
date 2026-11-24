import { APWError, Status } from "./const.ts";
import { type ByteReader, type ByteWriter, readExactText, readLine, writeAll } from "./transport.ts";

const encoder = new TextEncoder();

function assertEqual(actual: unknown, expected: unknown, message = "Unexpected value") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

async function assertRejectsStatus(promise: Promise<unknown>, status: Status) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof APWError && error.status === status) return;
    throw new Error("Rejected with an unexpected error");
  }
  throw new Error("Expected a rejection");
}

/** Delivers the given byte chunks one per read, copying at most `p.length` bytes, then reports EOF. */
function chunkedReader(chunks: Uint8Array[]): ByteReader & { reads: number } {
  const queue = chunks.map((c) => c.slice());
  return {
    reads: 0,
    read(p: Uint8Array) {
      this.reads++;
      const next = queue.shift();
      if (!next) return Promise.resolve(null);
      const n = Math.min(p.length, next.length);
      p.set(next.subarray(0, n));
      if (n < next.length) queue.unshift(next.subarray(n));
      return Promise.resolve(n);
    },
  };
}

/** Splits `bytes` into pieces of the given sizes, with the remainder as the last piece. */
function split(bytes: Uint8Array, ...sizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    out.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.length) out.push(bytes.subarray(offset));
  return out;
}

/** Accepts at most `limits[i]` bytes on call i (repeating the last limit) and records everything written. */
function shortWriter(...limits: number[]): ByteWriter & { written: number[]; calls: number } {
  return {
    written: [],
    calls: 0,
    write(p: Uint8Array) {
      const limit = limits[Math.min(this.calls, limits.length - 1)];
      this.calls++;
      const n = Math.min(limit, p.length);
      this.written.push(...p.subarray(0, n));
      return Promise.resolve(n);
    },
  };
}

Deno.test("writeAll finishes a payload across short writes", async () => {
  const data = encoder.encode(`${JSON.stringify({ value: "x".repeat(20_000) })}\n`);
  const writer = shortWriter(8192, 1, 3000);
  await writeAll(writer, data);
  assertEqual(writer.written.length, data.length);
  assertEqual(new Uint8Array(writer.written).every((b, i) => b === data[i]), true);
});

Deno.test("writeAll accepts an empty payload without writing", async () => {
  const writer = shortWriter(1);
  await writeAll(writer, new Uint8Array());
  assertEqual(writer.calls, 0);
});

Deno.test("writeAll fails instead of spinning when a write makes no progress", async () => {
  const writer = shortWriter(5, 0);
  await assertRejectsStatus(writeAll(writer, encoder.encode("0123456789")), Status.SERVER_ERROR);
  assertEqual(writer.calls, 2);
});

Deno.test("writeAll rejects impossible byte counts", async () => {
  for (const reported of [-1, 1.5, 11, NaN]) {
    const writer: ByteWriter = { write: () => Promise.resolve(reported) };
    await assertRejectsStatus(writeAll(writer, encoder.encode("0123456789")), Status.SERVER_ERROR);
  }
});

Deno.test("readLine reassembles multi-byte characters split across reads", async () => {
  const text = JSON.stringify({ title: "Café ✓ 🔑 日本" });
  const bytes = encoder.encode(`${text}\n`);
  const emoji = bytes.indexOf(0xf0);
  // Cut inside the 4-byte emoji and inside a 3-byte character.
  const reader = chunkedReader(split(bytes, emoji + 1, 2, 4, 1));
  assertEqual(await readLine(reader), text);
});

Deno.test("readLine decodes a byte-at-a-time stream", async () => {
  const text = "ünïcødé ✓";
  const bytes = encoder.encode(`${text}\n`);
  const reader = chunkedReader(Array.from(bytes, (b) => new Uint8Array([b])));
  assertEqual(await readLine(reader), text);
});

Deno.test("readLine frames on the first newline and ignores trailing bytes", async () => {
  const reader = chunkedReader([encoder.encode('{"a":1}\n{"b":2}\n')]);
  assertEqual(await readLine(reader), '{"a":1}');
});

Deno.test("readLine handles responses larger than one read buffer", async () => {
  const text = JSON.stringify({ value: "é".repeat(100_000) });
  const reader = chunkedReader([encoder.encode(`${text}\n`)]);
  assertEqual(await readLine(reader), text);
  assertEqual(reader.reads > 1, true);
});

Deno.test("readLine rejects a response truncated by EOF", async () => {
  await assertRejectsStatus(readLine(chunkedReader([encoder.encode('{"status":0')])), Status.SERVER_ERROR);
  await assertRejectsStatus(readLine(chunkedReader([])), Status.SERVER_ERROR);
});

Deno.test("readLine rejects invalid UTF-8 instead of replacing it", async () => {
  const reader = chunkedReader([new Uint8Array([0x22, 0xc3, 0x22, 0x0a])]);
  await assertRejectsStatus(readLine(reader), Status.SERVER_ERROR);
});

Deno.test("readLine enforces its size bound", async () => {
  const reader = chunkedReader([encoder.encode("x".repeat(100)), encoder.encode("\n")]);
  await assertRejectsStatus(readLine(reader, 64), Status.SERVER_ERROR);
  assertEqual(await readLine(chunkedReader([encoder.encode("x".repeat(64) + "\n")]), 64), "x".repeat(64));
});

Deno.test("readExactText keeps every supplied character, untrimmed", async () => {
  // Synthetic sample value only.
  const sample = "﻿  sample value\twith ✓ and 🔑 \r\n\n";
  const bytes = encoder.encode(sample);
  const reader = chunkedReader(split(bytes, 1, 2, 5, bytes.indexOf(0xf0) - 8 + 1, 2));
  assertEqual(await readExactText(reader), sample);
});

Deno.test("readExactText returns an empty string for empty input", async () => {
  assertEqual(await readExactText(chunkedReader([])), "");
});

Deno.test("readExactText rejects invalid UTF-8 and oversized input", async () => {
  await assertRejectsStatus(readExactText(chunkedReader([new Uint8Array([0x61, 0xff])])), Status.INVALID_PARAM);
  await assertRejectsStatus(readExactText(chunkedReader([encoder.encode("abcdef")]), 5), Status.INVALID_PARAM);
});
