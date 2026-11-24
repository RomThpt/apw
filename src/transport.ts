import { APWError, Status } from "./const.ts";

/** Minimal reader contract shared by `Deno.Conn`, `Deno.stdin` and test doubles. */
export interface ByteReader {
  read(p: Uint8Array): Promise<number | null>;
}

/** Minimal writer contract shared by `Deno.Conn` and test doubles. */
export interface ByteWriter {
  write(p: Uint8Array): Promise<number>;
}

const NEWLINE = 0x0a;
const CHUNK_SIZE = 64 * 1024;

/** Upper bound for a single daemon response line. */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** The daemon accepts requests up to 1 MiB, including framing and other fields. */
export const MAX_STDIN_SECRET_BYTES = 1024 * 1024;

/**
 * Writes every byte of `data`. A single `write()` may accept only part of the buffer (for example when a Unix socket
 * send buffer is full), so keep writing the remainder. Each call must make progress, which bounds the loop to at most
 * `data.length` iterations; a writer that reports zero or an impossible byte count is treated as broken.
 */
export async function writeAll(writer: ByteWriter, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const n = await writer.write(data.subarray(offset));
    if (!Number.isInteger(n) || n <= 0 || n > data.length - offset) {
      throw new APWError(Status.SERVER_ERROR, "Connection stopped accepting data");
    }
    offset += n;
  }
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Reads one newline-terminated UTF-8 line. Framing is done on raw bytes: 0x0A never occurs inside a multi-byte UTF-8
 * sequence, so a character split across reads is reassembled before decoding. The line must be complete and valid
 * UTF-8; bytes after the first newline are ignored because each connection carries a single response.
 */
export async function readLine(reader: ByteReader, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const buf = new Uint8Array(CHUNK_SIZE);
  while (true) {
    const n = await reader.read(buf);
    if (n === null) {
      throw new APWError(Status.SERVER_ERROR, "Connection closed before a complete response");
    }
    const chunk = buf.subarray(0, n);
    const newline = chunk.indexOf(NEWLINE);
    const part = newline === -1 ? chunk : chunk.subarray(0, newline);
    if (length + part.length > maxBytes) {
      throw new APWError(Status.SERVER_ERROR, "Response exceeds maximum size");
    }
    chunks.push(part.slice());
    length += part.length;
    if (newline !== -1) break;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(concat(chunks, length));
  } catch {
    throw new APWError(Status.SERVER_ERROR, "Response is not valid UTF-8");
  }
}

/**
 * Reads everything from `reader` and returns it as text exactly as supplied: no trimming, newline stripping or
 * byte-order-mark removal. Invalid UTF-8 is rejected instead of being silently replaced.
 */
export async function readExactText(reader: ByteReader, maxBytes = MAX_STDIN_SECRET_BYTES): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const buf = new Uint8Array(CHUNK_SIZE);
  while (true) {
    const n = await reader.read(buf);
    if (n === null) break;
    if (length + n > maxBytes) {
      throw new APWError(Status.INVALID_PARAM, "Input exceeds maximum size");
    }
    chunks.push(buf.slice(0, n));
    length += n;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(concat(chunks, length));
  } catch {
    throw new APWError(Status.INVALID_PARAM, "Input is not valid UTF-8");
  }
}
