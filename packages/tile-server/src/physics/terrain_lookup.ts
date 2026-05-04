/**
 * Shared terrain-height lookup builder.
 *
 * Every per-tick physics system (player + NPC, projectiles, items, future
 * vehicles or thrown weapons) needs the same query: "what is the authoritative
 * surface height at world (x, y)?"  Each system used to build its own copy of
 * the chunk lookup; this module collapses that into one pure function.
 *
 * The returned closure walks the world's Heightmap chunks once per call to
 * `buildTerrainLookup`, then snaps every (x, y) to its integer cell — the
 * same convention the heightmap chunk encodes (flat-topped cells, no
 * bilinear interpolation).  Out-of-tile coordinates return 0 and log once.
 */
import type { World } from "@voxim/engine";
import { Heightmap, OpenMask, getHeight, worldToChunk, worldToLocal, CHUNK_SIZE } from "@voxim/world";
import type { HeightmapData, OpenMaskData } from "@voxim/world";
import { createLogger } from "../logger.ts";

const log = createLogger("TerrainLookup");

export type TerrainHeightFn = (x: number, y: number) => number;
export type OpennessFn = (x: number, y: number) => boolean;

/**
 * Build a per-tick height lookup from the current world's Heightmap chunks.
 * Cheap (~256 chunks/tile, one map insert each); rebuilds every tick because
 * TerrainDigSystem replaces Heightmap components when cells are lowered, so
 * a stored closure would read pre-dig data.
 */
export function buildTerrainLookup(world: World): TerrainHeightFn {
  const chunkMap = new Map<string, HeightmapData>();
  for (const { heightmap } of world.query(Heightmap)) {
    chunkMap.set(`${heightmap.chunkX},${heightmap.chunkY}`, heightmap);
  }

  return (x: number, y: number): number => {
    const { chunkX, chunkY } = worldToChunk(x, y);
    const { localX, localY } = worldToLocal(x, y);
    const hm = chunkMap.get(`${chunkX},${chunkY}`);
    if (!hm) {
      log.warn("no heightmap for chunk (%d,%d) — query at (%.1f,%.1f) in void", chunkX, chunkY, x, y);
      return 0;
    }
    return getHeight(hm, Math.floor(localX), Math.floor(localY));
  };
}

/**
 * Build a per-tick openness lookup from the current world's OpenMask chunks.
 *
 * Returns true (open) for any query outside the loaded set so out-of-tile
 * coordinates don't accidentally block the player; returns true for cells
 * with value 1 in the chunk's mask, false for value 0.
 *
 * Same lifetime + rebuild discipline as buildTerrainLookup — one closure
 * per tick over the world's current chunks.
 */
export function buildOpennessLookup(world: World): OpennessFn {
  // OpenMask doesn't carry chunkX/chunkY itself, so join with Heightmap
  // (which does) to index by coordinate. Cheap — same chunk count.
  const chunkByCoord = new Map<string, OpenMaskData>();
  for (const { entityId, heightmap } of world.query(Heightmap)) {
    const om = world.get(entityId, OpenMask);
    if (om) chunkByCoord.set(`${heightmap.chunkX},${heightmap.chunkY}`, om);
  }

  return (x: number, y: number): boolean => {
    const { chunkX, chunkY } = worldToChunk(x, y);
    const { localX, localY } = worldToLocal(x, y);
    const om = chunkByCoord.get(`${chunkX},${chunkY}`);
    if (!om) return true; // out of tile — don't accidentally block
    const lx = Math.floor(localX);
    const ly = Math.floor(localY);
    return om.data[lx + ly * CHUNK_SIZE] === 1;
  };
}
