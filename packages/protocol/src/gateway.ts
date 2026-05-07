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
   * The gateway validates this against the sessions repo and rejects the
   * request with HTTP 401 when it is missing, unknown, or expired.
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

// ---- tile server → gateway (heartbeat) ----
// Sent every ~10s after registration. The gateway evicts tiles whose last
// heartbeat is older than its TTL (~30s). If the gateway has no record of
// the tileId (e.g. the tile was previously evicted while offline), it
// responds with `known: false` and the tile re-registers.

export interface GatewayHeartbeatRequest {
  type: "heartbeat";
  tileId: string;
}

export interface GatewayHeartbeatResponse {
  type: "heartbeat_ack";
  tileId: string;
  /** false → caller is not registered, must re-register before resuming. */
  known: boolean;
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
  /**
   * Display label rendered above the player's head. Sourced from the
   * client's stored login name. Empty string / missing → tile-server
   * uses a short fallback derived from `playerId`. Non-authoritative —
   * a future ticket should fetch the canonical username from the account
   * service alongside session validation.
   */
  displayName?: string;
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

// ---- service ↔ gateway WT stream handshake (T-137) ----
// First JSON frame on a privileged WebTransport stream from a tile-server
// or world-coordinator. Authenticates the peer with the shared service
// secret and identifies which kind of service it is. The gateway routes
// future frames on this stream based on `kind`.

export interface ServiceHandshake {
  type: "service_handshake";
  /** "tile" — one of the tile-servers; "coordinator" — the world coordinator. */
  kind: "tile" | "coordinator";
  /** Service secret matching gateway's VOXIM_SERVICE_SECRET. */
  secret: string;
  /** tileId — required when kind === "tile", omitted for coordinator. */
  id?: string;
}

export interface ServiceHandshakeAck {
  type: "service_handshake_ack";
  ok: boolean;
  /** Populated when ok === false. */
  reason?: string;
}

// ---- world event / tile command envelopes (T-139) ----
// JSON envelopes routed over the privileged WT bidi streams established by
// ServiceHandshake. Tile streams send WorldEventEnvelope up; gateway forwards
// to the connected coordinator. Coordinator stream sends TileCommandEnvelope
// down; gateway routes to the target tile-server's stream.
//
// Concrete event/command shapes are deliberately open-typed for now — each
// downstream ticket (T-140 gates, T-142 city sim, T-148 caravans) layers its
// own kind discriminant on top. Keeping the envelope generic means new
// event types don't require protocol-package changes.

export interface WorldEventEnvelope {
  type: "world_event";
  sourceTileId: string;
  /**
   * Discriminated by `kind`. Concrete shapes live in domain modules
   * (gates, caravans, etc.) to keep this package thin.
   */
  event: { kind: string; [k: string]: unknown };
}

export interface TileCommandEnvelope {
  type: "tile_command";
  targetTileId: string;
  command: { kind: string; [k: string]: unknown };
}
