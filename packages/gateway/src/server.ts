/**
 * GatewayServer — signaling only, never on the data hot path.
 *
 * What it does:
 *   - Hosts the account service (HTTPS) — register, login, /me
 *   - Resolves a session token to a tile address via POST /gateway/connect
 *   - Tracks tile-server registrations and forwards player handoffs between tiles
 *
 * What it does NOT do:
 *   - Forward any game data
 *   - Participate in the tick loop
 *   - Know anything about game state
 *
 * Persistence:
 *   - Postgres-backed via `@voxim/db` repositories. The pool is owned by the
 *     caller (main.ts) — server doesn't open or close it.
 *
 * Tile server registration (current — superseded by T-135 heartbeat flow):
 *   Tile servers call POST /register on startup with { tileId, address }.
 *   Stored in TileDirectory (still in-memory until T-135).
 */
import { EventBus } from "@voxim/engine";
import { WorldEvents } from "@voxim/protocol";
import type { GatewayConnectRequest, GatewayRegisterRequest, GatewayTileResponse } from "@voxim/protocol";
import type { UserRepo, HeritageRepo, SessionRepo } from "@voxim/db";
import { TileDirectory } from "./tile_directory.ts";
import { SessionService } from "./account/session_service.ts";
import { AccountEndpoints } from "./account/endpoints.ts";

function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get("origin") ?? "*";
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization");
  headers.set("access-control-max-age", "86400");
  headers.set("vary", "origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export interface GatewayConfig {
  /** Plain-HTTP port for /account/*, /gateway/connect, /register, /handoff, /internal/*. */
  port: number;
  /**
   * PEM cert string. Used only to compute the SHA-256 hash returned to
   * clients in /gateway/connect responses (so the browser can pin the tile's
   * matching cert via WebTransport serverCertificateHashes). The gateway
   * does NOT terminate TLS itself.
   */
  cert: string;
  /** Repository for users, heritage, and sessions. Owns the DB pool externally. */
  repos: {
    users: UserRepo;
    heritage: HeritageRepo;
    sessions: SessionRepo;
  };
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
  sessions!: SessionService;
  private users!: UserRepo;
  private accountEndpoints!: AccountEndpoints;
  /** SHA-256 of the gateway's TLS cert (hex). Served via /cert-hash so the
   *  browser client can pin self-signed dev certs through serverCertificateHashes. */
  private certHashHex = "";

  async start(config: GatewayConfig): Promise<void> {
    const b64 = config.cert.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const hashBuf = await crypto.subtle.digest("SHA-256", der);
    this.certHashHex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    this.users = config.repos.users;
    this.sessions = new SessionService(config.repos.sessions);
    this.accountEndpoints = new AccountEndpoints({
      users: config.repos.users,
      heritage: config.repos.heritage,
      sessions: this.sessions,
      serviceSecret: config.serviceSecret,
    });

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
      { port: config.port },
      async (req) => {
        try {
          return withCors(req, await this.handleRequest(req));
        } catch (err) {
          // Errors thrown from handlers MUST go through withCors too — otherwise
          // the browser sees a 500 with no Access-Control-Allow-* headers and
          // reports a misleading "CORS Missing Allow Header" instead of the
          // real failure. Log the cause server-side so we can debug.
          console.error("[Gateway] unhandled error:", err);
          const body = err instanceof Error ? err.message : "internal error";
          return withCors(req, new Response(body, { status: 500 }));
        }
      },
    );

    console.log(`[Gateway] listening on port ${config.port} (plain HTTP)`);
  }

  private async handleRequest(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });

    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/gateway/connect") {
      return this.handleConnect(req);
    }

    const accountResponse = await this.accountEndpoints.handle(req, url);
    if (accountResponse) return accountResponse;

    if (req.method === "POST" && url.pathname === "/register") {
      return this.handleRegister(req);
    }

    if (req.method === "POST" && url.pathname === "/handoff") {
      return this.handleHandoff(req);
    }

    return new Response("Voxim gateway", { status: 200 });
  }

  private async handleConnect(req: Request): Promise<Response> {
    let body: GatewayConnectRequest;
    try { body = await req.json() as GatewayConnectRequest; }
    catch { return new Response("bad request", { status: 400 }); }
    if (!body.token) return new Response("token required", { status: 400 });

    const userId = await this.sessions.validate(body.token);
    if (!userId) return new Response("unauthenticated", { status: 401 });

    const preferred = await this.directoryForUser(userId);
    if (!preferred) return new Response("no tile available", { status: 503 });

    this.directory.setPlayerTile(userId, preferred.tileId);

    const response: GatewayTileResponse = {
      tileId: preferred.tileId,
      tileAddress: preferred.address,
      playerId: userId,
      tileCertHashHex: this.certHashHex || undefined,
    };
    console.log(`[Gateway] user ${userId.slice(0, 8)} → tile ${preferred.tileId} (${preferred.address})`);
    return Response.json(response);
  }

  /**
   * Choose a tile for a user: prefer their last tile (sticky), fall back to
   * any registered tile.
   */
  private async directoryForUser(userId: string) {
    const user = await this.users.getById(userId);
    const preferred = user?.lastTileId ? this.directory.get(user.lastTileId) : null;
    return preferred ?? this.directory.tileForPlayer(userId);
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
