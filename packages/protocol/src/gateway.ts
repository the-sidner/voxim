/**
 * Gateway ↔ client handshake message types.
 *
 * Flow:
 *   1. Client opens WebTransport to gateway
 *   2. Client opens a bidirectional stream
 *   3. Client sends GatewayConnectRequest (length-prefixed JSON)
 *   4. Gateway responds with GatewayTileResponse (length-prefixed JSON)
 *   5. Client closes the gateway connection and opens direct WebTransport to tileAddress
 *
 * Gateway tile server registration (tile server → gateway):
 *   Tile servers call the gateway's register endpoint on startup.
 *   Format: GatewayRegisterRequest → GatewayRegisterResponse
 */

// ---- client → gateway ----

export interface GatewayConnectRequest {
  type: "connect";
  /** Optional pre-issued auth token from the auth service. Stub: ignored. */
  authToken?: string;
  /** Resume: client's existing player ID, if reconnecting. */
  playerId?: string;
}

// ---- gateway → client ----

export interface GatewayTileResponse {
  type: "tile";
  tileId: string;
  /**
   * WebTransport address the client should connect to directly.
   * Format: "hostname:port" e.g. "127.0.0.1:4434"
   */
  tileAddress: string;
  /** Assigned player ID for this session. */
  playerId: string;
}

export interface GatewayErrorResponse {
  type: "error";
  code: "not_found" | "auth_failed" | "server_full";
  message: string;
}

export type GatewayResponse = GatewayTileResponse | GatewayErrorResponse;

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
  /** The player ID assigned by the gateway. Omit for a brand-new session. */
  playerId?: string;
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
