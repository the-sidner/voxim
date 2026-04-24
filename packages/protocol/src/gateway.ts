/**
 * Gateway ↔ client handshake message types.
 *
 * Flow:
 *   1. Client POSTs GatewayConnectRequest to `${gatewayUrl}/gateway/connect`
 *      with the session token in the JSON body.
 *   2. Gateway returns 200 + GatewayTileResponse, or 401 (bad token) /
 *      503 (no tile available). HTTP status is the error channel — there is
 *      no separate error envelope.
 *   3. Client opens WebTransport directly to `tileAddress`, pinning
 *      `tileCertHashHex` if present (self-signed dev certs).
 *
 * Gateway tile server registration (tile server → gateway):
 *   Tile servers call the gateway's register endpoint on startup.
 *   Format: GatewayRegisterRequest → GatewayRegisterResponse
 */

// ---- client → gateway ----

export interface GatewayConnectRequest {
  /**
   * Session token issued by the account service (see POST /account/login).
   * The gateway validates this via SessionStore and rejects the request with
   * HTTP 401 when it is missing, unknown, or expired.
   */
  token: string;
}

// ---- gateway → client ----

export interface GatewayTileResponse {
  tileId: string;
  /**
   * WebTransport address the client should connect to directly.
   * Format: "hostname:port" e.g. "127.0.0.1:4434"
   */
  tileAddress: string;
  /** Assigned player ID for this session. */
  playerId: string;
  /**
   * SHA-256 (hex) of the tile server's TLS cert. Present only for self-signed
   * dev deployments where the gateway and tile share a cert; absent in
   * production where tiles use CA-signed certs and the browser handles trust.
   */
  tileCertHashHex?: string;
}

// ---- tile server → gateway (registration) ----

export interface GatewayRegisterRequest {
  type: "register";
  tileId: string;
  /** WebTransport address clients should use to connect directly. */
  address: string;
  /**
   * Plain HTTP URL for gateway → tile internal communication (handoff, health-check).
   * Format: "http://host:adminPort"
   */
  adminUrl: string;
}

export interface GatewayRegisterResponse {
  type: "registered";
  tileId: string;
}

// ---- client → tile server (join handshake) ----
// Sent on a bidirectional stream immediately after the WebTransport connection opens.
// Allows the tile server to reuse a pre-created entity (from a tile handoff) instead
// of spawning a fresh player.

export interface TileJoinRequest {
  type: "join";
  /**
   * The user ID assigned by the gateway (becomes this player's EntityId on
   * the tile). The tile server verifies this matches the token's owner.
   */
  playerId: string;
  /**
   * The same session token the client used against the gateway. The tile
   * validates it against the gateway's /internal/session endpoint and
   * refuses the join if the token is invalid, expired, or belongs to a
   * different user than the one claimed in `playerId`.
   */
  token: string;
}

export interface TileJoinAck {
  type: "joined";
  /** Canonical player ID assigned by this tile server. */
  playerId: string;
}

// ---- gateway → tile server (tile transition handoff) ----
// Stub: interface defined, not needed for the single-tile vertical slice.

export interface TileHandoffRequest {
  type: "handoff";
  playerId: string;
  /** Serialised player entity (all components) for the destination tile. */
  entityPayload: Uint8Array;
  destinationTileId: string;
}

export interface TileHandoffAck {
  type: "handoff_ack";
  playerId: string;
}
