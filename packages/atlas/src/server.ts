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
import { bakeWorld, tileSeedFor } from "./bake.ts";
import type { WorldCellRecord } from "./worldmap/types.ts";
import { DEFAULT_GEN_PARAMS, mergeGenParams, type DeepPartialGenParams, type GenParams } from "./genparams.ts";

export interface AtlasServerConfig {
  port: number;
  worldsRepo: WorldsRepo;
  cellsRepo: AtlasWorldRepo;
  tilesRepo: AtlasTileInitRepo;
  /**
   * Comma-separated host:port targets for /world/restart to POST
   * /admin/restart to. Default: tile-1:14433,coordinator:8083 (compose).
   * Empty list = restart endpoint is a no-op.
   */
  restartTargets?: string[];
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
    }, { name, seed, width, height, ...(body.params && { params: body.params }) });
    return jsonOk({ baked: worldToWire(w) });
  }

  // Defaults endpoint: lets the inspector populate forms with
  // DEFAULT_GEN_PARAMS without baking a throwaway world first.
  if (req.method === "GET" && url.pathname === "/genparams/defaults") {
    return jsonOk({ defaults: DEFAULT_GEN_PARAMS });
  }

  if (req.method === "POST" && url.pathname === "/world/restart") {
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

function readQueryNumber(url: URL, key: string, fallback: number): number {
  const v = url.searchParams.get(key);
  if (v === null) return fallback;
  const n = parseInt(v);
  return Number.isFinite(n) ? n : fallback;
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
  const tile = generateTile(cell, tileSeed);
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
