/// <reference path="./types/webtransport.d.ts" />
/**
 * Plain HTTP server for gateway → tile internal messages and static client asset serving.
 * Runs on a separate port from WebTransport so TLS is not required.
 */
import { serveDir } from "@std/http/file-server";
import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import { SERVICE_SECRET_HEADER, verifyServiceSecret } from "@voxim/protocol";
import { restorePlayer } from "./handoff.ts";
import { JobBoard, AssignedJobBoard } from "./components/job_board.ts";

export interface AdminServerDeps {
  world: World;
  /** Content service — handoff restore re-spawns the player through its prefab. */
  content: ContentService;
  /**
   * Shared secret gating the control-plane endpoints (/handoff, /jobs,
   * /assign-job-board) — T-258. The gateway presents it in the
   * X-Voxim-Service-Secret header when forwarding a handoff. Empty string
   * means no caller can authenticate (the endpoints fail closed).
   */
  serviceSecret: string;
  /** Returns the current cert SHA-256 fingerprint (hex). Called per-request. */
  getCertHashHex: () => string;
  /** Returns the current WebTransport port. Called per-request. */
  getWtPort: () => number;
}

/** Control-plane endpoints requiring the shared service secret (T-258). */
const CONTROL_PATHS = new Set(["/handoff", "/jobs", "/assign-job-board"]);

export function startAdminServer(port: number, deps: AdminServerDeps): void {
  // Bounded cache of handoffIds seen recently; a second POST with the same id
  // is acked immediately without re-spawning. Capped to avoid unbounded growth
  // from a misbehaving source; oldest ids are evicted first.
  const seenHandoffs = new Map<string, number>();
  const HANDOFF_CACHE_MAX = 1024;

  Deno.serve(
    { port, hostname: "0.0.0.0" },
    (req) => handleAdminRequest(req, deps, seenHandoffs, HANDOFF_CACHE_MAX),
  );
  console.log(`[TileServer] admin HTTP listening on 0.0.0.0:${port}`);
}

async function handleAdminRequest(
  req: Request,
  deps: AdminServerDeps,
  seenHandoffs: Map<string, number>,
  handoffCacheMax: number,
): Promise<Response> {
  const url = new URL(req.url);

  // Control plane — gateway/coordinator-facing. Gated by the shared service
  // secret (T-258). Everything else (/health, /cert-hash, /game, static
  // client assets) is public.
  if (CONTROL_PATHS.has(url.pathname) && !verifyServiceSecret(req, deps.serviceSecret)) {
    return new Response("unauthorized", { status: 401 });
  }

  if (req.method === "POST" && url.pathname === "/handoff") {
    try {
      const payload = await req.json();
      if (!payload.playerId || !payload.components || !payload.handoffId) {
        return new Response("bad request", { status: 400 });
      }
      // Idempotency: second POST with the same handoffId is a retry; ack and
      // return without touching the world again.
      if (seenHandoffs.has(payload.handoffId)) {
        return Response.json({ type: "handoff_ack", playerId: payload.playerId, replay: true });
      }
      // Cap cache size: drop oldest insertion before adding.
      if (seenHandoffs.size >= handoffCacheMax) {
        const oldest = seenHandoffs.keys().next().value;
        if (oldest !== undefined) seenHandoffs.delete(oldest);
      }
      seenHandoffs.set(payload.handoffId, Date.now());
      restorePlayer(deps.world, deps.content, payload);
      console.log(`[TileServer] received handoff ${payload.handoffId.slice(0, 8)} for player ${payload.playerId}`);
      return Response.json({ type: "handoff_ack", playerId: payload.playerId });
    } catch {
      return new Response("bad request", { status: 400 });
    }
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok" });
  }

  // ---- Job board admin ----
  // POST /jobs        body: { boardId, goal: "produce", itemType, priority? }
  //                   Appends a job to the named JobBoard entity's pending list.
  // POST /assign-job-board body: { npcId, boardId }
  //                   Assigns the NPC to pull work from the named board.
  if (req.method === "POST" && url.pathname === "/jobs") {
    try {
      const body = await req.json() as { boardId?: string; goal?: string; itemType?: string; priority?: number };
      if (!body.boardId || body.goal !== "produce" || !body.itemType) {
        return new Response("bad request: boardId, goal=produce, itemType required", { status: 400 });
      }
      const boardId = body.boardId as EntityId;
      const board = deps.world.get(boardId, JobBoard);
      if (!board || !deps.world.isAlive(boardId)) {
        return new Response("board not found", { status: 404 });
      }
      const jobId = newEntityId();
      const next = {
        pending: [...board.pending, {
          id: jobId,
          goal: "produce" as const,
          itemType: body.itemType,
          priority: body.priority ?? 0,
          claimedBy: null,
        }],
      };
      deps.world.set(boardId, JobBoard, next);
      return Response.json({ jobId });
    } catch {
      return new Response("bad request", { status: 400 });
    }
  }

  if (req.method === "POST" && url.pathname === "/assign-job-board") {
    try {
      const body = await req.json() as { npcId?: string; boardId?: string };
      if (!body.npcId || !body.boardId) {
        return new Response("bad request: npcId and boardId required", { status: 400 });
      }
      if (!deps.world.isAlive(body.npcId as EntityId) || !deps.world.isAlive(body.boardId as EntityId)) {
        return new Response("entity not found", { status: 404 });
      }
      deps.world.set(body.npcId as EntityId, AssignedJobBoard, { boardId: body.boardId });
      return Response.json({ ok: true });
    } catch {
      return new Response("bad request", { status: 400 });
    }
  }

  if (req.method === "GET" && url.pathname === "/cert-hash") {
    return Response.json(
      { sha256: deps.getCertHashHex() },
      { headers: { "access-control-allow-origin": "*" } },
    );
  }

  if (req.method === "GET" && url.pathname === "/game") {
    return Response.redirect(
      `${url.origin}/?tile=${encodeURIComponent(url.hostname + ":" + deps.getWtPort())}`,
      302,
    );
  }

  // Serve all other client assets (index.html, dist/game.js, src/ui/theme.css, etc.)
  return serveDir(req, {
    fsRoot: new URL("../../client", import.meta.url).pathname,
    quiet: true,
  });
}

/**
 * Default cadence: heartbeat every 10s; gateway evicts after 30s without one.
 */
const HEARTBEAT_INTERVAL_MS = 10_000;

interface RegisterParams {
  gatewayUrl: string;
  tileId: string;
  tileAddress: string;
  adminUrl: string;
  /** Shared secret for the gateway's guarded /register + /heartbeat (T-258). */
  serviceSecret: string;
}

async function sendRegister(params: RegisterParams): Promise<boolean> {
  try {
    const r = await fetch(`${params.gatewayUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SERVICE_SECRET_HEADER]: params.serviceSecret,
      },
      body: JSON.stringify({
        type: "register",
        tileId: params.tileId,
        address: params.tileAddress,
        adminUrl: params.adminUrl,
      }),
    });
    if (!r.ok) {
      console.error(`[TileServer] gateway registration failed: ${r.status}`);
      return false;
    }
    console.log(`[TileServer] registered with gateway as ${params.tileId} → ${params.tileAddress}`);
    return true;
  } catch (err) {
    console.error("[TileServer] could not reach gateway:", err);
    return false;
  }
}

async function sendHeartbeat(gatewayUrl: string, tileId: string, serviceSecret: string): Promise<{ known: boolean } | null> {
  try {
    const r = await fetch(`${gatewayUrl}/heartbeat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SERVICE_SECRET_HEADER]: serviceSecret,
      },
      body: JSON.stringify({ type: "heartbeat", tileId }),
    });
    if (!r.ok) return null;
    const ack = await r.json() as { known?: boolean };
    return { known: ack.known === true };
  } catch {
    // Gateway temporarily unreachable — try again next tick. Don't log every
    // failed beat; the gateway log will show the silence.
    return null;
  }
}

/**
 * Register with the gateway, then keep the registration alive with periodic
 * heartbeats. If the gateway evicts us (responds `known: false` — typically
 * because we were stale and got swept) we re-register.
 *
 * Fire-and-forget: kicks off the loop in the background and returns. The
 * tile-server's tick loop is unaffected by gateway availability.
 */
export function registerWithGateway(
  gatewayUrl: string,
  tileId: string,
  tileAddress: string,
  adminUrl: string,
  serviceSecret: string,
): void {
  const params: RegisterParams = { gatewayUrl, tileId, tileAddress, adminUrl, serviceSecret };

  void (async () => {
    await sendRegister(params);
    while (true) {
      await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_MS));
      const ack = await sendHeartbeat(gatewayUrl, tileId, serviceSecret);
      if (ack && !ack.known) {
        console.warn(`[TileServer] gateway evicted us; re-registering`);
        await sendRegister(params);
      }
    }
  })();
}
