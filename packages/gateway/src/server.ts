/**
 * GatewayServer — signaling only, never on the data hot path.
 *
 * What it does:
 *   - Hosts the account service — register, login, /me
 *   - Resolves a session token to a tile address via POST /gateway/connect
 *   - Tracks tile-server registrations + heartbeats; evicts stale ones
 *   - Forwards player handoffs between tiles
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
 * Tile lifecycle:
 *   - Tile-server boots → POST /register
 *   - Every ~10s: POST /heartbeat (fire-and-forget). If gateway responds
 *     `known: false`, the tile re-registers.
 *   - Gateway sweeps every 10s, evicting tiles whose last_heartbeat_at
 *     is older than 30s.
 */
import type {
  GatewayConnectRequest,
  GatewayRegisterRequest,
  GatewayHeartbeatRequest,
  GatewayHeartbeatResponse,
  GatewayTileResponse,
} from "@voxim/protocol";
import { SERVICE_SECRET_HEADER, verifyServiceSecret } from "@voxim/protocol";
import type { UserRepo, HeritageRepo, SessionRepo, TileRepo, UserTileFogRepo } from "@voxim/db";
import { SessionService } from "./account/session_service.ts";
import { AccountEndpoints } from "./account/endpoints.ts";
import { NoopSpawner, TileOrchestrator, type TileSpawner } from "./edge/tile_orchestrator.ts";
import { WtServer } from "./edge/wt_server.ts";

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
  /** Plain-HTTP port for /account/*, /gateway/connect, /register, /heartbeat, /handoff, /internal/*. */
  port: number;
  /**
   * UDP port for the WebTransport service listener (tile + coordinator
   * privileged streams). Defaults to 8080 if omitted.
   */
  wtPort?: number;
  /**
   * PEM cert string. Used (a) to compute the SHA-256 hash returned to
   * clients in /gateway/connect responses (so the browser can pin the tile's
   * matching cert via WebTransport serverCertificateHashes), and (b) as the
   * server cert for the WT service listener.
   */
  cert: string;
  /** PEM key string — required for the WT service listener. */
  key: string;
  repos: {
    users: UserRepo;
    heritage: HeritageRepo;
    sessions: SessionRepo;
    tiles: TileRepo;
    userFog: UserTileFogRepo;
  };
  /**
   * How to bring up a tile-server when the gateway needs one that isn't
   * registered. Today: `NoopSpawner` (throws). Future: docker / k8s.
   */
  spawner?: TileSpawner;
  /**
   * Shared secret gating the `/internal/*` server-to-server endpoints.
   * Must be non-empty (>=16 chars). Tile servers present this in the
   * `X-Voxim-Service-Secret` header when calling the account service.
   */
  serviceSecret: string;
}

export class GatewayServer {
  sessions!: SessionService;
  tiles!: TileOrchestrator;
  wt!: WtServer;
  private users!: UserRepo;
  private accountEndpoints!: AccountEndpoints;
  /** SHA-256 of the gateway's TLS cert (hex). Same cert as tile in dev. */
  private certHashHex = "";
  /** Shared secret gating the control-plane endpoints (T-258). Set in start(). */
  private serviceSecret = "";

  async start(config: GatewayConfig): Promise<void> {
    const b64 = config.cert.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const hashBuf = await crypto.subtle.digest("SHA-256", der);
    this.certHashHex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    this.serviceSecret = config.serviceSecret;
    this.users = config.repos.users;
    this.sessions = new SessionService(config.repos.sessions);
    this.tiles = new TileOrchestrator({
      repo: config.repos.tiles,
      spawner: config.spawner ?? new NoopSpawner(),
    });
    this.accountEndpoints = new AccountEndpoints({
      users: config.repos.users,
      heritage: config.repos.heritage,
      userFog: config.repos.userFog,
      sessions: this.sessions,
      serviceSecret: config.serviceSecret,
    });

    this.tiles.startSweepLoop();

    this.wt = new WtServer({
      port: config.wtPort ?? 8080,
      cert: config.cert,
      key: config.key,
      serviceSecret: config.serviceSecret,
    });
    this.wt.start();

    Deno.serve(
      { port: config.port },
      async (req) => {
        try {
          return withCors(req, await this.handleRequest(req));
        } catch (err) {
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

    // Control plane — tile/coordinator-facing. Gated by the shared service
    // secret (T-258). The player-facing /gateway/connect + /account/* paths
    // above are public and stay so.
    const isControl = req.method === "POST" &&
      (url.pathname === "/register" || url.pathname === "/heartbeat" || url.pathname === "/handoff");
    if (isControl) {
      if (!verifyServiceSecret(req, this.serviceSecret)) return new Response("unauthorized", { status: 401 });
      if (url.pathname === "/register")  return this.handleRegister(req);
      if (url.pathname === "/heartbeat") return this.handleHeartbeat(req);
      if (url.pathname === "/handoff")   return this.handleHandoff(req);
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

    const user = await this.users.getById(userId);
    if (!user) return new Response("user not found", { status: 401 });

    const tile = await this.tiles.tileFor(userId, user.lastTileId);
    if (!tile) return new Response("no tile available", { status: 503 });

    const response: GatewayTileResponse = {
      tileId: tile.tileId,
      tileAddress: tile.address,
      playerId: userId,
      tileCertHashHex: this.certHashHex || undefined,
    };
    console.log(`[Gateway] user ${userId.slice(0, 8)} → tile ${tile.tileId} (${tile.address})`);
    return Response.json(response);
  }

  private async handleHandoff(req: Request): Promise<Response> {
    let body: Record<string, unknown> | null = null;
    try {
      body = await req.json() as Record<string, unknown>;
      if (!body.destinationTileId || !body.playerId) {
        console.warn(`[Gateway] handoff bad request — missing fields:`, Object.keys(body));
        return new Response("bad request", { status: 400 });
      }
      const tile = await this.tiles.get(body.destinationTileId as string);
      if (!tile) {
        console.warn(`[Gateway] handoff: destination tile ${body.destinationTileId} not registered`);
        return new Response(JSON.stringify({ error: "tile not found" }), { status: 404 });
      }
      console.log(`[Gateway] handoff → ${tile.adminUrl}/handoff (player=${(body.playerId as string).slice(0, 8)}, dest=${body.destinationTileId})`);
      let resp: Response;
      try {
        resp = await fetch(`${tile.adminUrl}/handoff`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SERVICE_SECRET_HEADER]: this.serviceSecret,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        console.error(`[Gateway] handoff fetch to ${tile.adminUrl} failed:`, (err as Error).message);
        return new Response(`upstream fetch failed: ${(err as Error).message}`, { status: 502 });
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "<no body>");
        console.error(`[Gateway] destination tile responded ${resp.status}: ${text}`);
        return new Response(text, { status: resp.status });
      }
      const ack = await resp.json();
      // On a successful handoff (destination acked), update the user's
      // last_tile_id so future logins route to the correct tile. Best-effort:
      // if the user row doesn't exist (NPC handoff in the future, or test
      // data), the update silently no-ops.
      if (resp.ok) {
        try {
          await this.users.updateLocation(body.playerId as string, body.destinationTileId as string);
        } catch (err) {
          console.warn(`[Gateway] failed to update last_tile_id for ${body.playerId}:`, err);
        }
      }
      // Echo destination tile's WT address + cert fingerprint back to the
      // source tile so it can hand the client a direct redirect (T-141).
      // All tiles share the gateway's self-signed cert in dev; in prod with
      // CA-signed certs certHashHex stays empty.
      return Response.json({
        ...ack,
        destinationTileAddress: tile.address,
        destinationTileCertHashHex: this.certHashHex,
      });
    } catch (err) {
      console.error(`[Gateway] handoff threw:`, (err as Error).message);
      return new Response(`gateway error: ${(err as Error).message}`, { status: 400 });
    }
  }

  private async handleRegister(req: Request): Promise<Response> {
    try {
      const body = await req.json() as GatewayRegisterRequest;
      if (body.type !== "register" || !body.tileId || !body.address) {
        return new Response("bad request", { status: 400 });
      }
      await this.tiles.register({
        tileId: body.tileId,
        address: body.address,
        adminUrl: body.adminUrl ?? "",
      });
      return Response.json({ type: "registered", tileId: body.tileId });
    } catch {
      return new Response("bad request", { status: 400 });
    }
  }

  private async handleHeartbeat(req: Request): Promise<Response> {
    try {
      const body = await req.json() as GatewayHeartbeatRequest;
      if (body.type !== "heartbeat" || !body.tileId) {
        return new Response("bad request", { status: 400 });
      }
      const known = await this.tiles.heartbeat(body.tileId);
      const response: GatewayHeartbeatResponse = {
        type: "heartbeat_ack",
        tileId: body.tileId,
        known,
      };
      return Response.json(response);
    } catch {
      return new Response("bad request", { status: 400 });
    }
  }
}
