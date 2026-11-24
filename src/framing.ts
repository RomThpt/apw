// Byte-level framing helpers shared by the daemon's Unix socket and the browser DevTools pipe.
// Frames are assembled as bytes and decoded once complete, so multi-byte UTF-8 sequences split
// across reads are never decoded in halves.

export class FrameError extends Error {}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function concatBytes(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new FrameError("Message is not valid UTF-8");
  }
}

/**
 * Reads one newline-terminated frame (without the newline). Returns `null` if the peer closes
 * before sending a newline. Throws `FrameError` if the frame exceeds `maxBytes` or is not UTF-8.
 */
export async function readLineFrame(
  read: (buffer: Uint8Array) => Promise<number | null>,
  maxBytes: number,
): Promise<string | null> {
  const buffer = new Uint8Array(64 * 1024);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const n = await read(buffer);
    if (n === null) return null;
    const chunk = buffer.subarray(0, n);
    const newline = chunk.indexOf(0x0a);
    const part = newline === -1 ? chunk : chunk.subarray(0, newline);
    size += part.length;
    if (size > maxBytes) throw new FrameError("Message exceeds size limit");
    chunks.push(part.slice());
    if (newline !== -1) return decodeUtf8(concatBytes(chunks, size));
  }
}

/** Writes all of `data`, continuing after partial writes. */
export async function writeAll(write: (data: Uint8Array) => Promise<number>, data: Uint8Array): Promise<void> {
  for (let offset = 0; offset < data.length;) {
    const n = await write(data.subarray(offset));
    if (n <= 0) throw new FrameError("Connection stopped accepting data");
    offset += n;
  }
}

/** Splits a byte stream into NUL-terminated JSON objects, bounding the size of each message. */
export class NulJsonSplitter {
  private chunks: Uint8Array[] = [];
  private size = 0;

  constructor(private maxBytes: number) {}

  push(chunk: Uint8Array): Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = [];
    let start = 0;
    let end = chunk.indexOf(0);
    while (end !== -1) {
      this.append(chunk.subarray(start, end));
      messages.push(this.take());
      start = end + 1;
      end = chunk.indexOf(0, start);
    }
    this.append(chunk.subarray(start));
    return messages;
  }

  private append(part: Uint8Array): void {
    if (!part.length) return;
    this.size += part.length;
    if (this.size > this.maxBytes) throw new FrameError("Message exceeds size limit");
    this.chunks.push(part.slice());
  }

  private take(): Record<string, unknown> {
    const text = decodeUtf8(concatBytes(this.chunks, this.size));
    this.chunks = [];
    this.size = 0;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new FrameError("Message is not valid JSON");
    }
    if (!isRecord(value)) throw new FrameError("Message is not a JSON object");
    return value;
  }
}
