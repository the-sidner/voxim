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
import type { AtlasWorldRepo } from "@voxim/db";
import { generateWorldMap } from "./worldmap/generate.ts";

export interface AtlasServerConfig {
  port: number;
  repo: AtlasWorldRepo;
  worldId: string;
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
    const loaded = await cfg.repo.load(cfg.worldId);
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
    const loaded = await cfg.repo.load(cfg.worldId);
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
    await cfg.repo.save({
      worldId: cfg.worldId,
      seed: BigInt(seed),
      cells: wm.cells.map((c) => ({
        cellX: c.cellX,
        cellY: c.cellY,
        biome: c.biome as unknown as Record<string, unknown>,
        gates: c.gates as unknown as Record<string, unknown>,
      })),
    });
    return jsonOk({ regenerated: wm.cells.length, seed, width, height });
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
