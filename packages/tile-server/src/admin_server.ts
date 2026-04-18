/// <reference path="./types/webtransport.d.ts" />
/**
 * Plain HTTP server for gateway → tile internal messages and static client asset serving.
 * Runs on a separate port from WebTransport so TLS is not required.
 */
import { serveDir } from "@std/http/file-server";
import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { restorePlayer } from "./handoff.ts";
import { JobBoard, AssignedJobBoard } from "./components/job_board.ts";

export interface AdminServerDeps {
  world: World;
  /** Returns the current cert SHA-256 fingerprint (hex). Called per-request. */
  getCertHashHex: () => string;
  /** Returns the current WebTransport port. Called per-request. */
  getWtPort: () => number;
}

export function startAdminServer(port: number, deps: AdminServerDeps): void {
  // Bounded cache of handoffIds seen recently; a second POST with the same id
  // is acked immediately without re-spawning. Capped to avoid unbounded growth
  // from a misbehaving source; oldest ids are evicted first.
  const seenHandoffs = new Map<string, number>();
  const HANDOFF_CACHE_MAX = 1024;

  Deno.serve(
    { port, hostname: "127.0.0.1" },
    (req) => handleAdminRequest(req, deps, seenHandoffs, HANDOFF_CACHE_MAX),
  );
  console.log(`[TileServer] admin HTTP listening on 127.0.0.1:${port}`);
}

async function handleAdminRequest(
  req: Request,
  deps: AdminServerDeps,
  seenHandoffs: Map<string, number>,
  handoffCacheMax: number,
): Promise<Response> {
  const url = new URL(req.url);

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
      restorePlayer(deps.world, payload);
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

export function registerWithGateway(
  gatewayUrl: string,
  tileId: string,
  tileAddress: string,
  adminUrl: string,
): void {
  fetch(`${gatewayUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "register", tileId, address: tileAddress, adminUrl }),
  }).then((r) => {
    if (!r.ok) console.error(`[TileServer] gateway registration failed: ${r.status}`);
    else console.log(`[TileServer] registered with gateway as ${tileId} → ${tileAddress}`);
  }).catch((err: unknown) => {
    console.error("[TileServer] could not reach gateway:", err);
  });
}
