/// <reference lib="deno.ns" />
/**
 * Atlas HTTP server.
 *
 * Worlds are the unit of organisation. Most read endpoints scope to "the
 * active world" (latest baked_at). The bake endpoint produces a new world
 * (new uuid). Restart endpoint nudges sibling services to exit so they
 * pick up the new active world.
 *
 *   GET  /health                          liveness
 *
 *   GET  /world                           active world: cells + metadata
 *   GET  /world/cell/:x/:y                one cell from the active world
 *   GET  /world/summaries                 per-tile gateSummary u16 list
 *   POST /world/bake                      ?seed=&width=&height=&name=  → new world row
 *   POST /world/restart                   POST /admin/restart to RESTART_TARGETS
 *
 *   GET  /tile/:cellX/:cellY              full tile_init payload (active world)
 *   POST /tile/:cellX/:cellY/regen        re-derive one tile (active world)
 *
 *   GET  /worlds                          history list (every bake)
 *
 *   GET  /                                inspector world-view UI
 *   GET  /inspector/...                   inspector static assets
 */

import { serveDir } from "@std/http/file-server";
import type { AtlasTileInitRepo, AtlasWorldRepo, WorldRow, WorldsRepo } from "@voxim/db";
import { generateTile, tileInitToWire } from "./tilemap/generate.ts";
import {
  decodeState,
  encodeState,
  runInstrumented,
  TileCache,
  type StageTrace,
} from "./tilemap/instrumented_runner.ts";
import { ORDERED_STAGES, type StageId } from "./tilemap/pipeline/stages.ts";
import { deriveGateSummary } from "./tilemap/summary.ts";
import type { TileInit } from "./tilemap/types.ts";
import { bakeWorld, tileSeedFor } from "./bake.ts";
import type { WorldCellRecord } from "./worldmap/types.ts";
import { DEFAULT_GEN_PARAMS, PRESETS, mergeGenParams, type DeepPartialGenParams, type GenParams } from "./genparams.ts";
import type { ContentService } from "@voxim/content";
import { verifyServiceSecret } from "@voxim/protocol";

export interface AtlasServerConfig {
  port: number;
  worldsRepo: WorldsRepo;
  cellsRepo: AtlasWorldRepo;
  tilesRepo: AtlasTileInitRepo;
  /**
   * Shared secret gating the mutating control-plane endpoints
   * (/world/bake, /world/restart) — T-258. Read endpoints + the inspector
   * UI stay public. Empty string → those endpoints fail closed.
   */
  serviceSecret: string;
  /**
   * Comma-separated host:port targets for /world/restart to POST
   * /admin/restart to. Default: tile-1:14433,coordinator:8083 (compose).
   * Empty list = restart endpoint is a no-op.
   */
  restartTargets?: string[];
  /**
   * Optional content store — when provided, the inspector pipeline
   * endpoint runs the POI-network matcher (T-209) and the response
   * carries a populated `narrative`. When absent, narrative is empty.
   * The bake / regen paths don't need this (POI matching is
   * inspector-side for v1).
   */
  content?: ContentService;
}

function tileIdFor(cellX: number, cellY: number): string {
  return `${cellX}_${cellY}`;
}

export function startAtlasServer(cfg: AtlasServerConfig): void {
  Deno.serve(
    { port: cfg.port, hostname: "0.0.0.0" },
    (req) => handleRequest(req, cfg),
  );
  console.log(`[Atlas] listening on 0.0.0.0:${cfg.port}`);
}

async function handleRequest(req: Request, cfg: AtlasServerConfig): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return jsonOk({ status: "ok", service: "atlas" });
  }

  if (req.method === "GET" && url.pathname === "/worlds") {
    const worlds = await cfg.worldsRepo.list();
    return jsonOk({ worlds: worlds.map(worldToWire) });
  }

  if (req.method === "GET" && url.pathname === "/world") {
    const active = await cfg.worldsRepo.getLatest();
    if (!active) return jsonOk({ world: null, cells: [] });
    const cells = await cfg.cellsRepo.load(active.id);
    return jsonOk({
      world: worldToWire(active),
      cells: cells?.cells ?? [],
    });
  }

  // GET /world/cell/:x/:y
  const cellMatch = url.pathname.match(/^\/world\/cell\/(-?\d+)\/(-?\d+)$/);
  if (req.method === "GET" && cellMatch) {
    const cx = parseInt(cellMatch[1]);
    const cy = parseInt(cellMatch[2]);
    const active = await cfg.worldsRepo.getLatest();
    if (!active) return notFound("no active world");
    const cells = await cfg.cellsRepo.load(active.id);
    if (!cells) return notFound("no cells");
    const cell = cells.cells.find((c) => c.cellX === cx && c.cellY === cy);
    if (!cell) return notFound(`cell ${cx},${cy} not in active world`);
    return jsonOk({ world: worldToWire(active), cell });
  }

  if (req.method === "POST" && url.pathname === "/world/bake") {
    // Control plane (T-258): mutating endpoint — requires the shared secret.
    if (!verifyServiceSecret(req, cfg.serviceSecret)) {
      return new Response("unauthorized", { status: 401, headers: { "access-control-allow-origin": "*" } });
    }
    // Body is optional; query string provides convenient simple-knob access
    // (?seed=&width=&height=&name=). For tuning the deeper GenParams,
    // POST a JSON body { name, seed, width, height, params: { ... } }.
    let body: {
      name?: string;
      seed?: number;
      width?: number;
      height?: number;
      params?: DeepPartialGenParams;
    } = {};
    if (req.headers.get("content-type")?.includes("application/json")) {
      try { body = await req.json(); } catch { /* ignore — fall back to query */ }
    }
    const name   = body.name   ?? url.searchParams.get("name") ?? `bake-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const seed   = body.seed   ?? readQueryNumber(url, "seed",   1);
    const width  = body.width  ?? readQueryNumber(url, "width",  2);
    const height = body.height ?? readQueryNumber(url, "height", 2);
    const w = await bakeWorld({
      worldsRepo: cfg.worldsRepo,
      cellsRepo:  cfg.cellsRepo,
      tilesRepo:  cfg.tilesRepo,
      content:    cfg.content,
    }, { name, seed, width, height, ...(body.params && { params: body.params }) });
    return jsonOk({ baked: worldToWire(w) });
  }

  // Defaults endpoint: lets the inspector populate forms with
  // DEFAULT_GEN_PARAMS without baking a throwaway world first.
  if (req.method === "GET" && url.pathname === "/genparams/defaults") {
    return jsonOk({ defaults: DEFAULT_GEN_PARAMS });
  }

  // Named presets — strong shapes the inspector exposes as a dropdown.
  if (req.method === "GET" && url.pathname === "/genparams/presets") {
    return jsonOk({ presets: PRESETS });
  }

  // Stage metadata for the inspector trace panel (T-205): id, label,
  // and which GenParams slice each stage consumes. Stable as long as
  // the pipeline shape is stable.
  if (req.method === "GET" && url.pathname === "/pipeline/stages") {
    return jsonOk({
      stages: ORDERED_STAGES.map((s) => ({
        id: s.id, label: s.label, paramsKey: s.paramsKey,
      })),
    });
  }

  if (req.method === "POST" && url.pathname === "/world/restart") {
    // Control plane (T-258): mutating endpoint — requires the shared secret.
    if (!verifyServiceSecret(req, cfg.serviceSecret)) {
      return new Response("unauthorized", { status: 401, headers: { "access-control-allow-origin": "*" } });
    }
    const targets = cfg.restartTargets ?? [];
    const results: Array<{ target: string; ok: boolean; error?: string }> = [];
    for (const t of targets) {
      try {
        const r = await fetch(`http://${t}/admin/restart`, { method: "POST" });
        results.push({ target: t, ok: r.ok });
      } catch (e) {
        results.push({ target: t, ok: false, error: (e as Error).message });
      }
    }
    return jsonOk({ targets: results });
  }

  if (req.method === "GET" && url.pathname === "/world/summaries") {
    const active = await cfg.worldsRepo.getLatest();
    if (!active) return jsonOk({ summaries: [] });
    const summaries = await cfg.tilesRepo.listSummaries(active.id);
    return jsonOk({
      summaries: summaries.map((s) => ({
        cellX:   s.cellX,
        cellY:   s.cellY,
        summary: s.summary,
        seed:    Number(s.seed),
      })),
    });
  }

  // GET /tile/:cellX/:cellY (lazy: regenerates if missing or seed-stale)
  const tileGet = url.pathname.match(/^\/tile\/(-?\d+)\/(-?\d+)$/);
  if (req.method === "GET" && tileGet) {
    return await getOrGenerateTile(cfg, parseInt(tileGet[1]), parseInt(tileGet[2]));
  }

  // POST /tile/:cellX/:cellY/regen
  const tileRegen = url.pathname.match(/^\/tile\/(-?\d+)\/(-?\d+)\/regen$/);
  if (req.method === "POST" && tileRegen) {
    const cx = parseInt(tileRegen[1]);
    const cy = parseInt(tileRegen[2]);
    const active = await cfg.worldsRepo.getLatest();
    if (!active) return notFound("no active world");
    await cfg.tilesRepo.delete(active.id, tileIdFor(cx, cy));
    return await getOrGenerateTile(cfg, cx, cy);
  }

  // POST /tile/:cellX/:cellY/pipeline — instrumented run for the inspector.
  // Body (all optional): { params?: DeepPartialGenParams, seedOverride?: number,
  //                        resumeFromStage?: StageId, seedState?: encoded state,
  //                        intermediates?: boolean (default true) }
  // Returns: { tileId, cellX, cellY, world, trace, final (TileInitWire),
  //            intermediates: Record<StageId, encoded state>, cacheSize }
  const tilePipe = url.pathname.match(/^\/tile\/(-?\d+)\/(-?\d+)\/pipeline$/);
  if (req.method === "POST" && tilePipe) {
    return await runTilePipeline(cfg, parseInt(tilePipe[1]), parseInt(tilePipe[2]), req);
  }

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin":  "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }

  // Dreamborn tokens + primitives are owned by the client package; atlas
  // imports them as-is so palette/fonts/spacing stay in sync across every
  // surface (game UI, voxel-editor, studio, inspector).
  if (req.method === "GET" && url.pathname === "/theme.css") {
    return await serveStatic(
      new URL("../../../packages/client/src/ui/theme.css", import.meta.url).pathname,
      "text/css",
    );
  }

  if (req.method === "GET") {
    const res = await serveDir(req, {
      fsRoot: new URL("./inspector/ui", import.meta.url).pathname,
      quiet: true,
    });
    // Inspector assets change every iteration of the design loop. No-cache
    // makes "save file → hard-reload not needed" work cleanly; the dev cycle
    // matters more than caching here.
    res.headers.set("cache-control", "no-cache, no-store, must-revalidate");
    return res;
  }

  return notFound("not found");
}

// ---- helpers --------------------------------------------------------------

function worldToWire(w: WorldRow): Record<string, unknown> {
  // Merge persisted params over defaults so the inspector always sees the
  // full effective param set (older worlds with partial params still
  // expose every field).
  const params = mergeGenParams(w.params as unknown as DeepPartialGenParams);
  return {
    id: w.id,
    name: w.name,
    seed: Number(w.seed),
    width: w.width,
    height: w.height,
    version: w.version,
    bakedAt: w.bakedAt.toISOString(),
    params,
  };
}

function jsonOk(body: unknown): Response {
  return Response.json(body, { headers: { "access-control-allow-origin": "*" } });
}

function notFound(msg: string): Response {
  return new Response(msg, {
    status: 404,
    headers: { "access-control-allow-origin": "*" },
  });
}

async function serveStatic(absPath: string, mime: string): Promise<Response> {
  try {
    const data = await Deno.readFile(absPath);
    return new Response(data, {
      headers: {
        "content-type":  mime,
        "cache-control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch {
    return notFound(`missing ${absPath}`);
  }
}

function readQueryNumber(url: URL, key: string, fallback: number): number {
  const v = url.searchParams.get(key);
  if (v === null) return fallback;
  const n = parseInt(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---- inspector pipeline runner -------------------------------------------

/**
 * Per-tile in-memory caches keyed by `${worldId}:${cellX}_${cellY}`. The
 * inspector keeps one cache alive per open tile so consecutive
 * `/pipeline` calls reuse upstream stage outputs. There is no eviction
 * — the process is small and an open inspector at most has a handful of
 * tiles in play; restart the server to clear all caches.
 */
const TILE_CACHES = new Map<string, TileCache>();

function cacheKeyFor(worldId: string, cellX: number, cellY: number): string {
  return `${worldId}:${cellX}_${cellY}`;
}

async function runTilePipeline(
  cfg: AtlasServerConfig,
  cellX: number,
  cellY: number,
  req: Request,
): Promise<Response> {
  const active = await cfg.worldsRepo.getLatest();
  if (!active) return notFound("no active world");
  const cells = await cfg.cellsRepo.load(active.id);
  if (!cells) return notFound("no cells in active world");
  const cellRow = cells.cells.find((c) => c.cellX === cellX && c.cellY === cellY);
  if (!cellRow) return notFound(`cell ${cellX},${cellY} not in active world`);

  let body: {
    params?: DeepPartialGenParams;
    seedOverride?: number;
    resumeFromStage?: StageId;
    seedState?: unknown;
    intermediates?: boolean;
    /**
     * T-214 step 4: optional stage-order override. When present, the
     * runner iterates this list instead of the canonical
     * `ORDERED_STAGES`. Inspector "reducer reordering" mode sends
     * this each time the user drags a row.
     */
    stageOrder?: StageId[];
  } = {};
  if (req.headers.get("content-type")?.includes("application/json")) {
    try { body = await req.json(); } catch { /* ignore */ }
  }

  const worldSeed = Number(active.seed);
  const tileSeed  = body.seedOverride ?? tileSeedFor(worldSeed, cellX, cellY);
  // Merge body params over the world's persisted params so an inspector
  // edit can tweak a single field without re-sending the full GenParams.
  const worldParams: GenParams = mergeGenParams(active.params as unknown as DeepPartialGenParams);
  const params: GenParams = body.params
    ? mergeGenParams({ ...worldParams as unknown as DeepPartialGenParams, ...body.params })
    : worldParams;

  const cacheKey = cacheKeyFor(active.id, cellX, cellY);
  let cache = TILE_CACHES.get(cacheKey);
  if (!cache) {
    cache = new TileCache();
    TILE_CACHES.set(cacheKey, cache);
  }

  const cell: WorldCellRecord = {
    cellX:  cellRow.cellX,
    cellY:  cellRow.cellY,
    biome:  cellRow.biome  as unknown as WorldCellRecord["biome"],
    gates:  cellRow.gates  as unknown as WorldCellRecord["gates"],
    rivers: cellRow.rivers as unknown as WorldCellRecord["rivers"],
  };

  const result = runInstrumented({
    worldCell: cell,
    tileSeed,
    params,
    cache,
    content: cfg.content,
    resumeFromStage: body.resumeFromStage,
    seedState: body.seedState !== undefined ? decodeState(body.seedState) : undefined,
    stageOrder: body.stageOrder,
  });

  // Encode the final tile (re-uses tileInitToWire by constructing a
  // TileInit shape from the materials-stage final state) and every
  // intermediate state into wire form. Trace passes through as-is.
  const intermediates = body.intermediates === false
    ? {}
    : Object.fromEntries(
        Object.entries(result.intermediates).map(([k, v]) => [k, encodeState(v)]),
      );

  // For the "final" view, the inspector can reuse the existing tile
  // render path that consumes TileInitWire — so we emit that too.
  const tile = generateTileInitFromFinal(result.final, cellX, cellY, tileSeed);

  return jsonOk({
    tileId: tileIdFor(cellX, cellY),
    cellX, cellY,
    seed:   tileSeed,
    world:  worldToWire(active),
    params, // effective params after merge (for inspector form sync)
    trace:  result.trace satisfies StageTrace[],
    final:  tileInitToWire(tile),
    intermediates,
    cacheSize: cache.size,
  });
}

function generateTileInitFromFinal(
  final: ReturnType<typeof runInstrumented>["final"],
  cellX: number,
  cellY: number,
  _tileSeed: number,
): TileInit {
  return {
    cellX, cellY,
    tileSize:  final.tileSize,
    gridSize:  final.gridSize,
    openMask:  final.openMask,
    roomOf:    final.roomOf,
    rooms:     final.rooms,
    chamberOf: final.chamberOf,
    chambers:  final.chambers,
    corridors: final.corridors,
    portals:   final.portals,
    gateSummary: deriveGateSummary(final.portals),
    heightMap: final.heightMap,
    materials: final.materials,
    kindOf:    final.kindOf,
    level:     final.level,
    fields:    final.fields,
    boundaries: [],
    features:   [],
  };
}

async function getOrGenerateTile(
  cfg: AtlasServerConfig,
  cellX: number,
  cellY: number,
): Promise<Response> {
  const active = await cfg.worldsRepo.getLatest();
  if (!active) return notFound("no active world");

  const cells = await cfg.cellsRepo.load(active.id);
  if (!cells) return notFound("no cells in active world");
  const cellRow = cells.cells.find((c) => c.cellX === cellX && c.cellY === cellY);
  if (!cellRow) return notFound(`cell ${cellX},${cellY} not in active world`);

  const tileId    = tileIdFor(cellX, cellY);
  const worldSeed = Number(active.seed);
  const tileSeed  = tileSeedFor(worldSeed, cellX, cellY);

  const cached = await cfg.tilesRepo.get(active.id, tileId);
  if (cached && Number(cached.seed) === tileSeed) {
    return jsonOk({
      tileId, cellX, cellY, seed: tileSeed,
      world: worldToWire(active),
      payload: cached.payload,
    });
  }

  const cell: WorldCellRecord = {
    cellX:  cellRow.cellX,
    cellY:  cellRow.cellY,
    biome:  cellRow.biome as unknown as WorldCellRecord["biome"],
    gates:  cellRow.gates as unknown as WorldCellRecord["gates"],
    rivers: cellRow.rivers as unknown as WorldCellRecord["rivers"],
  };
  // T-257: use the world's persisted GenParams — falling back to
  // DEFAULT_GEN_PARAMS made on-demand tiles diverge from baked siblings.
  const lazyParams = mergeGenParams(active.params as unknown as DeepPartialGenParams);
  const tile = generateTile(cell, tileSeed, { content: cfg.content, params: lazyParams });
  const payload = tileInitToWire(tile) as unknown as Record<string, unknown>;
  await cfg.tilesRepo.put({
    worldId: active.id,
    tileId,
    cellX,
    cellY,
    seed: BigInt(tileSeed),
    payload,
  });
  return jsonOk({
    tileId, cellX, cellY, seed: tileSeed,
    world: worldToWire(active),
    payload,
  });
}
