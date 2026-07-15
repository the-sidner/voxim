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
import type { World, EntityId } from "@voxim/engine";
import { Heightmap, OpenMask, getHeight, CHUNK_SIZE } from "@voxim/world";
import type { HeightmapData, OpenMaskData } from "@voxim/world";
import { createLogger } from "../logger.ts";

const log = createLogger("TerrainLookup");

export type TerrainHeightFn = (x: number, y: number) => number;
export type OpennessFn = (x: number, y: number) => boolean;

/**
 * Packed numeric chunk key. Probes are the hottest loops on the server
 * (fog LOS alone is ~8,800/player/tick), and a template-string key costs a
 * string allocation + string hash per probe; a plain number is neither.
 * Valid chunk coords are 0..15, so ×2^16 is collision-free for any
 * out-of-tile query a physics probe can realistically produce (they just
 * miss the map, same as the string key did).
 */
function chunkKey(chunkX: number, chunkY: number): number {
  return chunkX * 0x10000 + chunkY;
}

/**
 * Build a per-tick height lookup from the current world's Heightmap chunks.
 * Cheap (~256 chunks/tile, one map insert each); rebuilds every tick because
 * TerrainDigSystem replaces Heightmap components when cells are lowered, so
 * a stored closure would read pre-dig data.
 */
export function buildTerrainLookup(world: World): TerrainHeightFn {
  const chunkMap = new Map<number, HeightmapData>();
  for (const { heightmap } of world.query(Heightmap)) {
    chunkMap.set(chunkKey(heightmap.chunkX, heightmap.chunkY), heightmap);
  }

  // Allocation-free probe: chunk/local math inlined (worldToChunk/
  // worldToLocal return fresh objects) + numeric map key. floor(x) − cx·32
  // equals floor(worldToLocal(x)) for negative coordinates too.
  return (x: number, y: number): number => {
    const chunkX = Math.floor(x / CHUNK_SIZE);
    const chunkY = Math.floor(y / CHUNK_SIZE);
    const hm = chunkMap.get(chunkKey(chunkX, chunkY));
    if (!hm) {
      log.warn("no heightmap for chunk (%d,%d) — query at (%.1f,%.1f) in void", chunkX, chunkY, x, y);
      return 0;
    }
    return getHeight(hm, Math.floor(x) - chunkX * CHUNK_SIZE, Math.floor(y) - chunkY * CHUNK_SIZE);
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
  const chunkByCoord = new Map<number, OpenMaskData>();
  for (const { entityId, heightmap } of world.query(Heightmap)) {
    const om = world.get(entityId, OpenMask);
    if (om) chunkByCoord.set(chunkKey(heightmap.chunkX, heightmap.chunkY), om);
  }

  // Same allocation-free probe shape as buildTerrainLookup above.
  return (x: number, y: number): boolean => {
    const chunkX = Math.floor(x / CHUNK_SIZE);
    const chunkY = Math.floor(y / CHUNK_SIZE);
    const om = chunkByCoord.get(chunkKey(chunkX, chunkY));
    if (!om) return true; // out of tile — don't accidentally block
    const lx = Math.floor(x) - chunkX * CHUNK_SIZE;
    const ly = Math.floor(y) - chunkY * CHUNK_SIZE;
    return om.data[lx + ly * CHUNK_SIZE] === 1;
  };
}

export interface ChunkIndexEntry {
  entityId: EntityId;
  heightmap: HeightmapData;
}

/**
 * Build a per-tick chunk index (coord → {entityId, heightmap}) for mutation
 * paths that need to call world.set(chunkId, Heightmap, ...) — the
 * read-only buildTerrainLookup only returns a height *value*, not the
 * entity to write back to. Same rebuild-every-call discipline as
 * buildTerrainLookup: Heightmap components get replaced wholesale on
 * dig/build, so a stored index would go stale.
 */
export function buildChunkIndex(world: World): Map<string, ChunkIndexEntry> {
  const index = new Map<string, ChunkIndexEntry>();
  for (const { entityId, heightmap } of world.query(Heightmap)) {
    index.set(`${heightmap.chunkX},${heightmap.chunkY}`, { entityId, heightmap });
  }
  return index;
}
