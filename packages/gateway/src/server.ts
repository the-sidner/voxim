/// <reference path="./types/webtransport.d.ts" />
/**
 * GatewayServer — signaling only, never on the data hot path.
 *
 * What it does:
 *   - Accepts initial WebTransport connections from clients
 *   - Runs the handshake: authenticate → look up tile → return tile server address
 *   - Client then connects directly to the tile server; gateway steps out
 *
 * What it does NOT do:
 *   - Forward any game data
 *   - Participate in the tick loop
 *   - Know anything about game state
 *
 * Tile server registration:
 *   Tile servers call POST /register on startup with { tileId, address }.
 *   The gateway stores this in TileDirectory. Tile servers are expected to
 *   re-register after a crash; the directory is in-memory (no persistence yet).
 *
 * Tile transition handoff (stub):
 *   Interface defined in @voxim/protocol (TileHandoffRequest / TileHandoffAck).
 *   Not needed for the single-tile vertical slice — the player always stays on tile_0.
 */
import { EventBus } from "@voxim/engine";
import { WorldEvents } from "@voxim/protocol";
import type { GatewayRegisterRequest } from "@voxim/protocol";
import { TileDirectory } from "./tile_directory.ts";
import { handleGatewaySession } from "./session.ts";
import { AccountStore } from "./account/store.ts";
import { SessionStore } from "./account/session_store.ts";
import { AccountEndpoints } from "./account/endpoints.ts";

export interface GatewayConfig {
  port: number;
  /** PEM TLS certificate (WebTransport requires TLS). */
  cert: string;
  /** PEM TLS key. */
  key: string;
  /**
   * Tile servers to register at startup (vertical slice shortcut).
   * In production: tile servers register themselves via POST /register.
   * adminUrl defaults to "http://localhost:14434" when omitted.
   */
  initialTiles?: Array<{ tileId: string; address: string; adminUrl?: string }>;
  /** Directory for the account service's user files. Required for auth. */
  accountsDir: string;
  /**
   * Shared secret gating the `/internal/*` server-to-server endpoints.
   * Must be non-empty (>=16 chars). Tile servers present this in the
   * `X-Voxim-Service-Secret` header when calling the account service.
   */
  serviceSecret: string;
}

export class GatewayServer {
  readonly directory = new TileDirectory();
  /** World event bus — tile servers publish cross-tile events here. Stub: no subscribers yet. */
  readonly worldEvents = new EventBus();
  accountStore!: AccountStore;
  sessions!: SessionStore;
  private accountEndpoints!: AccountEndpoints;

  async start(config: GatewayConfig): Promise<void> {
    // Pre-register tiles from config (vertical slice convenience)
    for (const tile of config.initialTiles ?? []) {
      this.directory.register({
        tileId: tile.tileId,
        address: tile.address,
        adminUrl: tile.adminUrl ?? "http://localhost:14434",
      });
    }

    this.accountStore = new AccountStore(config.accountsDir);
    await this.accountStore.init();
    this.sessions = new SessionStore();
    this.accountEndpoints = new AccountEndpoints({
      store: this.accountStore,
      sessions: this.sessions,
      serviceSecret: config.serviceSecret,
    });

    // Stub: subscribe to world events for future macro simulation
    this.worldEvents.subscribe(WorldEvents.PlayerCrossedGate, (_payload) => {
      // TODO: update directory.setPlayerTile, coordinate tile handoff
    });
    this.worldEvents.subscribe(WorldEvents.TileServerStarted, (_payload) => {
      // TODO: register the new tile in the directory
    });
    this.worldEvents.subscribe(WorldEvents.TileServerStopped, (_payload) => {
      // TODO: deregister the tile, migrate players
    });

    Deno.serve(
      { port: config.port, cert: config.cert, key: config.key },
      (req) => this.handleRequest(req),
    );

    console.log(`[Gateway] listening on port ${config.port}`);
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // WebTransport upgrade — client initiating a new session
    if (req.headers.get("upgrade") === "webtransport") {
      // deno-lint-ignore no-explicit-any
      const { session, response } = (Deno as any).upgradeWebTransport(req);
      handleGatewaySession(session as WebTransportSession, {
        directory: this.directory,
        accountStore: this.accountStore,
        sessions: this.sessions,
      }).catch(
        (err: unknown) => console.error("[Gateway] session error", err),
      );
      return response as Response;
    }

    // Account service — client /account/* and server-to-server /internal/*.
    // Returns null when the path doesn't match, so we fall through to the
    // tile-registration / handoff handlers below.
    const accountResponse = await this.accountEndpoints.handle(req, url);
    if (accountResponse) return accountResponse;

    // Tile server self-registration
    if (req.method === "POST" && url.pathname === "/register") {
      return this.handleRegister(req);
    }

    // Player tile handoff (initiated by source tile server)
    if (req.method === "POST" && url.pathname === "/handoff") {
      return this.handleHandoff(req);
    }

    return new Response("Voxim gateway", { status: 200 });
  }

  private async handleHandoff(req: Request): Promise<Response> {
    try {
      const body = await req.json();
      if (!body.destinationTileId || !body.playerId) {
        return new Response("bad request", { status: 400 });
      }
      const tile = this.directory.get(body.destinationTileId);
      if (!tile) {
        return new Response(JSON.stringify({ error: "tile not found" }), { status: 404 });
      }
      // Forward handoff payload to destination tile's admin endpoint
      const resp = await fetch(`${tile.adminUrl}/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const ack = await resp.json();
      return Response.json(ack);
    } catch {
      return new Response("bad request", { status: 400 });
    }
  }

  private async handleRegister(req: Request): Promise<Response> {
    try {
      const body = await req.json() as GatewayRegisterRequest;
      if (body.type !== "register" || !body.tileId || !body.address) {
        return new Response("bad request", { status: 400 });
      }
      this.directory.register({ tileId: body.tileId, address: body.address, adminUrl: body.adminUrl ?? "" });
      return Response.json({ type: "registered", tileId: body.tileId });
    } catch {
      return new Response("bad request", { status: 400 });
    }
  }
}
