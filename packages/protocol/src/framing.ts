/**
 * Length-prefixed frame helpers — shared by gateway, tile server, and client.
 *
 * Wire format: [4-byte LE uint32 payload length][payload bytes]
 * Used for all JSON and binary messages on WebTransport bidirectional streams.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Encode a JSON value as a length-prefixed frame. */
export function encodeFrame(value: unknown): Uint8Array {
  const payload = enc.encode(JSON.stringify(value));
  const out = new Uint8Array(4 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength, true);
  out.set(payload, 4);
  return out;
}

/**
 * Returns a stateful reader over a WebTransport stream that handles chunk
 * boundaries.  Each stream must get its own instance — the overflow buffer
 * is not shared.
 */
export function makeFrameReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let overflow: Uint8Array | null = null;

  async function readExact(n: number): Promise<Uint8Array | null> {
    const buf = new Uint8Array(n);
    let offset = 0;
    if (overflow) {
      const take = Math.min(overflow.byteLength, n);
      buf.set(overflow.subarray(0, take), 0);
      offset = take;
      overflow = overflow.byteLength > take ? overflow.subarray(take) : null;
    }
    while (offset < n) {
      const { value, done } = await reader.read();
      if (done || !value) return null;
      const take = Math.min(value.byteLength, n - offset);
      buf.set(value.subarray(0, take), offset);
      offset += take;
      if (value.byteLength > take) overflow = value.subarray(take);
    }
    return buf;
  }

  /** Read the next length-prefixed JSON message. */
  async function readJson(): Promise<unknown | null> {
    const header = await readExact(4);
    if (!header) return null;
    const len = new DataView(header.buffer).getUint32(0, true);
    const payload = await readExact(len);
    if (!payload) return null;
    return JSON.parse(dec.decode(payload));
  }

  /**
   * Read the next length-prefixed frame as a single Uint8Array
   * containing both the 4-byte header and the payload.
   * Useful when the downstream codec expects the full framed bytes.
   */
  async function readFrame(): Promise<Uint8Array | null> {
    const header = await readExact(4);
    if (!header) return null;
    const len = new DataView(header.buffer).getUint32(0, true);
    const payload = await readExact(len);
    if (!payload) return null;
    const full = new Uint8Array(4 + len);
    full.set(header, 0);
    full.set(payload, 4);
    return full;
  }

  /** Read the next length-prefixed frame's payload bytes only (no header). */
  async function readPayload(): Promise<Uint8Array | null> {
    const header = await readExact(4);
    if (!header) return null;
    const len = new DataView(header.buffer).getUint32(0, true);
    return readExact(len);
  }

  return { readExact, readJson, readFrame, readPayload };
}
