/// <reference lib="deno.ns" />
/**
 * Atlas HTTP server.
 *
 * Phase 1 endpoints:
 *   GET  /health                    liveness
 *   GET  /world                     full worldmap (seed + cells JSON)
 *   GET  /world/cell/:x/:y          one cell by grid coords
 *   POST /world/regen               drop + regenerate worldmap
 *   GET  /                          inspector world-view UI
 *   GET  /inspector/...             inspector static assets
 *
 * The inspector is served from packages/atlas/src/inspector/ui as plain
 * static files. No bundling step yet — keep it iterable.
 */

import { serveDir } from "@std/http/file-server";
import type { AtlasTileInitRepo, AtlasWorldRepo } from "@voxim/db";
import { generateWorldMap } from "./worldmap/generate.ts";
import { generateTile, tileInitToWire } from "./tilemap/generate.ts";
import type { WorldCellRecord } from "./worldmap/types.ts";

export interface AtlasServerConfig {
  port: number;
  worldRepo: AtlasWorldRepo;
  tileRepo: AtlasTileInitRepo;
  worldId: string;
}

/** Deterministic per-tile seed derived from (worldSeed, cellX, cellY). */
function tileSeedFor(worldSeed: number, cellX: number, cellY: number): number {
  return ((worldSeed * 0x9e3779b1) ^ (cellX * 73856093) ^ (cellY * 19349663)) >>> 0;
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

async function handleRequest(
  req: Request,
  cfg: AtlasServerConfig,
): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return jsonOk({ status: "ok", service: "atlas", phase: 1 });
  }

  if (req.method === "GET" && url.pathname === "/world") {
    const loaded = await cfg.worldRepo.load(cfg.worldId);
    if (!loaded) return jsonOk({ seed: null, cells: [] });
    return jsonOk({
      seed: Number(loaded.seed),
      cells: loaded.cells,
    });
  }

  // GET /world/cell/:x/:y
  const cellMatch = url.pathname.match(/^\/world\/cell\/(-?\d+)\/(-?\d+)$/);
  if (req.method === "GET" && cellMatch) {
    const cx = parseInt(cellMatch[1]);
    const cy = parseInt(cellMatch[2]);
    const loaded = await cfg.worldRepo.load(cfg.worldId);
    if (!loaded) return notFound("no worldmap");
    const cell = loaded.cells.find((c) => c.cellX === cx && c.cellY === cy);
    if (!cell) return notFound(`cell ${cx},${cy} not found`);
    return jsonOk({ seed: Number(loaded.seed), cell });
  }

  if (req.method === "POST" && url.pathname === "/world/regen") {
    const seed   = readQueryNumber(url, "seed",   1);
    const width  = readQueryNumber(url, "width",  4);
    const height = readQueryNumber(url, "height", 4);
    const wm = generateWorldMap(seed, width, height);
    await cfg.worldRepo.save({
      worldId: cfg.worldId,
      seed: BigInt(seed),
      cells: wm.cells.map((c) => ({
        cellX: c.cellX,
        cellY: c.cellY,
        biome: c.biome as unknown as Record<string, unknown>,
        gates: c.gates as unknown as Record<string, unknown>,
        rivers: c.rivers as unknown as unknown[],
      })),
    });
    // Worldmap re-seeded → all existing tile_init rows are stale.
    await cfg.tileRepo.deleteAll(cfg.worldId);
    // Eagerly regenerate every tile so the inspector world view has full
    // summary coverage immediately. Tiny world (≤ 256 cells) → fast.
    let tilesGenerated = 0;
    for (const cell of wm.cells) {
      const tileSeed = tileSeedFor(seed, cell.cellX, cell.cellY);
      const t = generateTile(cell, tileSeed);
      await cfg.tileRepo.put({
        worldId: cfg.worldId,
        tileId:  tileIdFor(cell.cellX, cell.cellY),
        cellX:   cell.cellX,
        cellY:   cell.cellY,
        seed:    BigInt(tileSeed),
        payload: tileInitToWire(t) as unknown as Record<string, unknown>,
      });
      tilesGenerated++;
    }
    return jsonOk({ regenerated: wm.cells.length, tilesGenerated, seed, width, height });
  }

  if (req.method === "GET" && url.pathname === "/world/summaries") {
    const summaries = await cfg.tileRepo.listSummaries(cfg.worldId);
    // Repo returns `seed` as Postgres bigint; downcast to number so
    // Response.json() doesn't choke. Seeds at our scale fit in 32 bits.
    return jsonOk({
      summaries: summaries.map((s) => ({
        cellX:   s.cellX,
        cellY:   s.cellY,
        summary: s.summary,
        seed:    Number(s.seed),
      })),
    });
  }

  // GET /tile/:cellX/:cellY  (lazy: regenerates if missing or seed-stale)
  const tileGet = url.pathname.match(/^\/tile\/(-?\d+)\/(-?\d+)$/);
  if (req.method === "GET" && tileGet) {
    const cx = parseInt(tileGet[1]);
    const cy = parseInt(tileGet[2]);
    return await getOrGenerateTile(cfg, cx, cy);
  }

  // POST /tile/:cellX/:cellY/regen  (force regenerate)
  const tileRegen = url.pathname.match(/^\/tile\/(-?\d+)\/(-?\d+)\/regen$/);
  if (req.method === "POST" && tileRegen) {
    const cx = parseInt(tileRegen[1]);
    const cy = parseInt(tileRegen[2]);
    await cfg.tileRepo.delete(tileIdFor(cx, cy), cfg.worldId);
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

  // Static inspector — serveDir handles "/" → index.html itself.
  if (req.method === "GET") {
    return serveDir(req, {
      fsRoot: new URL("./inspector/ui", import.meta.url).pathname,
      quiet: true,
    });
  }

  return notFound("not found");
}

// ---- helpers --------------------------------------------------------------

function jsonOk(body: unknown): Response {
  return Response.json(body, {
    headers: { "access-control-allow-origin": "*" },
  });
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

/**
 * Lazy tile fetch: return the cached payload if it matches the current
 * worldmap seed; otherwise generate from the worldmap cell and persist.
 *
 * Returns 404 if the worldmap doesn't exist yet (boot ordering issue) or
 * if the requested cell is out of the worldmap bounds.
 */
async function getOrGenerateTile(
  cfg: AtlasServerConfig,
  cellX: number,
  cellY: number,
): Promise<Response> {
  const tileId = tileIdFor(cellX, cellY);
  const world = await cfg.worldRepo.load(cfg.worldId);
  if (!world) return notFound("no worldmap");

  const cellRow = world.cells.find((c) => c.cellX === cellX && c.cellY === cellY);
  if (!cellRow) return notFound(`cell ${cellX},${cellY} not in worldmap`);

  const worldSeed = Number(world.seed);
  const tileSeed  = tileSeedFor(worldSeed, cellX, cellY);

  const cached = await cfg.tileRepo.get(tileId, cfg.worldId);
  if (cached && Number(cached.seed) === tileSeed) {
    return jsonOk({ tileId, cellX, cellY, seed: tileSeed, payload: cached.payload });
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
  await cfg.tileRepo.put({
    worldId: cfg.worldId,
    tileId,
    cellX,
    cellY,
    seed: BigInt(tileSeed),
    payload,
  });
  return jsonOk({ tileId, cellX, cellY, seed: tileSeed, payload });
}
