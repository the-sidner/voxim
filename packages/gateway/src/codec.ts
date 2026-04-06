/**
 * Length-prefixed JSON codec for gateway messages.
 * Wire format: [4-byte LE u32 payload length][UTF-8 JSON payload]
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeJson(value: unknown): Uint8Array {
  const payload = enc.encode(JSON.stringify(value));
  const out = new Uint8Array(4 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength, true);
  out.set(payload, 4);
  return out;
}

export function decodeJson(bytes: Uint8Array): unknown {
  const len = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  return JSON.parse(dec.decode(bytes.slice(4, 4 + len)));
}

/** Read one length-prefixed message from a ReadableStream reader. */
export async function readMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<unknown | null> {
  // Read the 4-byte length prefix
  const header = await readExact(reader, 4);
  if (!header) return null;
  const len = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, true);
  const payload = await readExact(reader, len);
  if (!payload) return null;
  return JSON.parse(new TextDecoder().decode(payload));
}

async function readExact(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
): Promise<Uint8Array | null> {
  const buf = new Uint8Array(n);
  let offset = 0;
  while (offset < n) {
    const { value, done } = await reader.read();
    if (done || !value) return null;
    const take = Math.min(value.byteLength, n - offset);
    buf.set(value.subarray(0, take), offset);
    offset += take;
  }
  return buf;
}
