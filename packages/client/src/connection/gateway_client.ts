/// <reference lib="dom" />
/**
 * Gateway handshake — connects to the gateway, performs the WebTransport
 * handshake, and returns the tile server address + assigned player ID.
 *
 * After this returns the caller should close the gateway WebTransport and open
 * a new connection directly to the tile server.
 */
import type { GatewayConnectRequest, GatewayTileResponse, GatewayErrorResponse } from "@voxim/protocol";
import { encodeFrame, makeFrameReader } from "@voxim/protocol";

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
 * @param token       Session token from POST /account/login. Required — the
 *                    gateway rejects connections without one. Missing or
 *                    expired tokens produce a GatewayError with
 *                    code="unauthenticated"; callers should treat that as a
 *                    signal to clear the locally-stored token and re-show
 *                    the login screen.
 */
export async function connectViaGateway(
  gatewayUrl: string,
  token: string,
): Promise<GatewayResult> {
  const transport = new WebTransport(gatewayUrl);
  await transport.ready;

  const stream = await transport.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  try {
    const req: GatewayConnectRequest = { type: "connect", token };
    await writer.write(encodeFrame(req));
    await writer.close();

    const resp = await makeFrameReader(reader).readJson() as GatewayTileResponse | GatewayErrorResponse | null;
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
