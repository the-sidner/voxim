/// <reference lib="dom" />
/**
 * Gateway handshake — POSTs the session token to the gateway and receives
 * the tile address + assigned player ID + (optional) tile cert hash.
 *
 * Plain HTTPS — no WebTransport. The gateway is signaling-only and a single
 * request/response is the entire handshake; using HTTP/2 keeps the gateway
 * out of the QUIC stack entirely.
 */
import type { GatewayConnectRequest, GatewayTileResponse } from "@voxim/protocol";

export interface GatewayResult {
  playerId: string;
  tileId: string;
  /** "hostname:port" — caller prepends https:// for the tile WebTransport. */
  tileAddress: string;
  /** SHA-256 (hex) of the tile cert, when the gateway is configured to share it. */
  tileCertHashHex?: string;
}

export async function connectViaGateway(gatewayUrl: string, token: string): Promise<GatewayResult> {
  const body: GatewayConnectRequest = { token };
  console.log(`[Gateway] POST ${gatewayUrl}/gateway/connect`);
  const res = await fetch(`${gatewayUrl}/gateway/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 401) throw new Error("Gateway error: unauthenticated — invalid or expired session");
  if (!res.ok) throw new Error(`Gateway error: HTTP ${res.status} — ${await res.text().catch(() => "")}`);

  const resp = await res.json() as GatewayTileResponse;
  console.log(`[Gateway] tile assigned: ${resp.tileId} @ ${resp.tileAddress} player=${resp.playerId.slice(0, 8)}`);
  return {
    playerId: resp.playerId,
    tileId: resp.tileId,
    tileAddress: resp.tileAddress,
    tileCertHashHex: resp.tileCertHashHex,
  };
}
