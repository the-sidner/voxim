/// <reference lib="dom" />
/**
 * Gateway handshake — connects to the gateway, performs the WebTransport
 * handshake, and returns the tile server address + assigned player ID.
 *
 * After this returns the caller should close the gateway WebTransport and open
 * a new connection directly to the tile server.
 */
import type { GatewayConnectRequest, GatewayTileResponse, GatewayErrorResponse } from "@voxim/protocol";

// ----- length-prefixed JSON codec (mirrors gateway/src/codec.ts) -----

const enc = new TextEncoder();
const dec = new TextDecoder();

function encodeMessage(value: unknown): Uint8Array {
  const payload = enc.encode(JSON.stringify(value));
  const out = new Uint8Array(4 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength, true);
  out.set(payload, 4);
  return out;
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

async function readMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<unknown | null> {
  const header = await readExact(reader, 4);
  if (!header) return null;
  const len = new DataView(header.buffer).getUint32(0, true);
  const payload = await readExact(reader, len);
  if (!payload) return null;
  return JSON.parse(dec.decode(payload));
}

// ----- public API -----

export interface GatewayResult {
  playerId: string;
  tileId: string;
  /** "hostname:port" — caller prepends https:// for WebTransport. */
  tileAddress: string;
}

/**
 * Perform the gateway handshake.
 *
 * @param gatewayUrl  Full WebTransport URL, e.g. "https://localhost:8080"
 * @param playerId    Existing player ID for reconnect. Omit for a new session.
 */
export async function connectViaGateway(
  gatewayUrl: string,
  playerId?: string,
): Promise<GatewayResult> {
  const transport = new WebTransport(gatewayUrl);
  await transport.ready;

  const stream = await transport.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  try {
    const req: GatewayConnectRequest = {
      type: "connect",
      ...(playerId ? { playerId } : {}),
    };
    await writer.write(encodeMessage(req));
    await writer.close();

    const resp = await readMessage(reader) as GatewayTileResponse | GatewayErrorResponse | null;
    if (!resp) throw new Error("Gateway closed without response");
    if (resp.type === "error") {
      throw new Error(`Gateway error: ${resp.code} — ${resp.message}`);
    }
    return {
      playerId: resp.playerId,
      tileId: resp.tileId,
      tileAddress: resp.tileAddress,
    };
  } finally {
    reader.releaseLock();
    writer.releaseLock();
    transport.close();
  }
}
