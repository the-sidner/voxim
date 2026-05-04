/**
 * Atlas bake — single entry point that creates a world.
 *
 * Each bake:
 *   1. Allocates a fresh uuid (worlds.id is never reused).
 *   2. Generates the worldmap deterministically from (seed, width, height).
 *   3. Inserts the `worlds` row first so the FK on cells/tiles resolves.
 *   4. Bulk-inserts all cells.
 *   5. Generates and inserts each cell's tile_init.
 *
 * Returns the new world's metadata. Services pick up the new world by
 * polling `worlds` (they restart when the latest baked_at moves past
 * their boot snapshot).
 */

import type { AtlasTileInitRepo, AtlasWorldRepo, WorldRow, WorldsRepo } from "@voxim/db";
import { generateWorldMap } from "./worldmap/generate.ts";
import { generateTile, tileInitToWire } from "./tilemap/generate.ts";

export interface BakeInput {
  name: string;
  seed: number;
  width: number;
  height: number;
}

export interface BakeDeps {
  worldsRepo: WorldsRepo;
  cellsRepo: AtlasWorldRepo;
  tilesRepo: AtlasTileInitRepo;
}

export async function bakeWorld(deps: BakeDeps, input: BakeInput): Promise<WorldRow> {
  const id = crypto.randomUUID();

  // Insert the worlds row FIRST — the FK on cells / tile_init points at it.
  const world = await deps.worldsRepo.insert({
    id,
    name: input.name,
    seed: BigInt(input.seed),
    width: input.width,
    height: input.height,
  });

  // Generate + persist cells.
  const wm = generateWorldMap(input.seed, input.width, input.height);
  await deps.cellsRepo.save({
    worldId: id,
    seed: BigInt(input.seed),
    cells: wm.cells.map((c) => ({
      cellX: c.cellX,
      cellY: c.cellY,
      biome: c.biome as unknown as Record<string, unknown>,
      gates: c.gates as unknown as Record<string, unknown>,
      rivers: c.rivers as unknown as unknown[],
    })),
  });

  // Generate + persist tile_init for every cell. Eager so coordinator can
  // seed its world graph from the DB and tile-server can read its tile
  // immediately after restart with no convergence wait.
  for (const cell of wm.cells) {
    const tileSeed = tileSeedFor(input.seed, cell.cellX, cell.cellY);
    const t = generateTile(cell, tileSeed);
    await deps.tilesRepo.put({
      worldId: id,
      tileId:  `${cell.cellX}_${cell.cellY}`,
      cellX:   cell.cellX,
      cellY:   cell.cellY,
      seed:    BigInt(tileSeed),
      payload: tileInitToWire(t) as unknown as Record<string, unknown>,
    });
  }

  return world;
}

/**
 * Per-tile seed: deterministic hash of (worldSeed, cellX, cellY). Same
 * function tile-server uses, so atlas's lazy-fetch endpoints in server.ts
 * compute the same value when looking up the row.
 */
export function tileSeedFor(worldSeed: number, cellX: number, cellY: number): number {
  return ((worldSeed * 0x9e3779b1) ^ (cellX * 73856093) ^ (cellY * 19349663)) >>> 0;
}
