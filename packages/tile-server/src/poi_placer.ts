/**
 * POI placer (T-160) — first primitive of the point-of-interest system.
 *
 * Each pre-network chamber from atlas gets a deterministic dice roll keyed by
 * `(tileSeed, chamberId)`.  Roll selects one of three outcomes:
 *
 *   - mob POI   → 3 random NPCs spawn near the chamber centroid.
 *   - room POI  → a small wooden enclosure is stamped into the terrain
 *                 buffers (closed openMask, raised heightmap, wood material,
 *                 stone kind to suppress forest decoration).  One cell on
 *                 the south wall is left open as a doorway.
 *   - empty     → nothing.
 *
 * Determinism: same `(tileSeed, chamberId)` always produces the same POI, so
 * a tile-server restart respawns the same layout (NPCs are re-spawned from
 * config; the room walls survive in the terrain save if one exists).
 *
 * The room POI mutates the terrain buffers in place — that's why this runs
 * BEFORE `chunksFromBuffers`.  Mob POIs are returned as a list and spawned
 * AFTER chunks are committed (they need the world graph populated).
 */
import type { World } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import { spawnPrefab } from "./spawner.ts";

const TILE_SIZE = 512;
const WALL_HEIGHT = 2.0;

/** Mirror of atlas's BOUNDARY_KIND_*; literals keep atlas out of tile-server's runtime bundle. */
const BOUNDARY_KIND_OPEN  = 0;
const BOUNDARY_KIND_STONE = 1;

/** Pool of NPC prefab ids used by the mob POI.  Wired by id; kept lean for "first primitive". */
const MOB_NPC_POOL = ["wolf", "bandit", "archer"] as const;

/** Number of NPCs spawned per mob POI.  User spec: "3 random mobs". */
const MOB_COUNT = 3;

/** Half-extent of the wood-walled room in cells (room footprint = 2*HALF + 1). */
const ROOM_HALF = 2;

/** Probabilities for chamber feature selection.  Must sum to ≤ 1. */
const P_MOB  = 0.40;
const P_ROOM = 0.25;
// remainder = empty

interface ChamberInfo {
  id: number;
  cx: number;   // world-unit centroid x
  cy: number;   // world-unit centroid y
  pixelCount: number;
}

export interface MobSpawn {
  prefabId: string;
  x: number;
  y: number;
}

/** Mulberry32 — same PRNG procedural_spawner uses; matched on purpose. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Place POIs for every chamber.  Mutates `heights` / `opens` / `kinds` /
 * `materials` in place for room POIs; returns a list of mob spawns for the
 * caller to instantiate after chunks are committed.
 *
 * `woodMaterialId` and `floorMaterialFallbackId` are tile-server's content
 * material ids (atlas-id translation has already happened by this point).
 */
export function placePois(
  heights: Float32Array,
  opens: Uint8Array,
  kinds: Uint16Array,
  materials: Uint16Array,
  chambers: ChamberInfo[],
  tileSeed: number,
  woodMaterialId: number,
): MobSpawn[] {
  const mobs: MobSpawn[] = [];
  let mobChambers = 0;
  let roomChambers = 0;

  for (const ch of chambers) {
    // Skip tiny chambers — they're not meaningful POI hosts and a 5×5 room
    // wouldn't fit anyway.
    if (ch.pixelCount < 25) continue;

    // Seed = tileSeed XOR chamberId so different tiles get different POIs
    // but each (tile, chamber) pair is stable across restarts.
    const rng = mulberry32(tileSeed ^ ch.id);
    const roll = rng();

    const cx = Math.floor(ch.cx);
    const cy = Math.floor(ch.cy);

    if (roll < P_MOB) {
      // Mob POI — 3 NPCs in a small cluster around the chamber centre.
      for (let i = 0; i < MOB_COUNT; i++) {
        const npc = MOB_NPC_POOL[Math.floor(rng() * MOB_NPC_POOL.length)];
        const dx = (rng() - 0.5) * 2.5;
        const dy = (rng() - 0.5) * 2.5;
        mobs.push({ prefabId: npc, x: ch.cx + dx, y: ch.cy + dy });
      }
      mobChambers++;
    } else if (roll < P_MOB + P_ROOM) {
      // Room POI — stamp a 5×5 wooden enclosure around the chamber centre.
      stampRoom(heights, opens, kinds, materials, cx, cy, woodMaterialId);
      roomChambers++;
    }
    // else: empty chamber.
  }

  console.log(
    `[POI] placed across ${chambers.length} chambers: ` +
    `${mobChambers} mob (${mobs.length} NPCs), ${roomChambers} rooms`,
  );
  return mobs;
}

/**
 * Spawn the mob NPCs returned by {@link placePois}.  Called after
 * `chunksFromBuffers` so the world graph (chunks, terrain) is in place.
 * Skips any spawn whose prefab id isn't in the content store — keeps
 * `MOB_NPC_POOL` resilient to content changes.
 */
export function spawnMobPois(
  world: World,
  content: ContentStore,
  mobs: MobSpawn[],
): void {
  for (const m of mobs) {
    if (!content.getPrefab(m.prefabId)) continue;
    spawnPrefab(world, content, m.prefabId, { x: m.x, y: m.y });
  }
}

/**
 * Stamp a small wooden-walled enclosure into the terrain buffers, with a
 * one-cell doorway gap on the south wall so the player can walk in.
 *
 * The room footprint is `(2*ROOM_HALF + 1)` cells per axis.  Walls form a
 * one-cell-thick perimeter; the interior stays open.
 */
function stampRoom(
  heights: Float32Array,
  opens: Uint8Array,
  kinds: Uint16Array,
  materials: Uint16Array,
  cx: number,
  cy: number,
  woodMaterialId: number,
): void {
  const x0 = cx - ROOM_HALF, x1 = cx + ROOM_HALF;
  const y0 = cy - ROOM_HALF, y1 = cy + ROOM_HALF;
  if (x0 < 0 || y0 < 0 || x1 >= TILE_SIZE || y1 >= TILE_SIZE) return;

  // Read the local floor height from the chamber centre — it's open ground,
  // so heights[idx] is exactly the floor.  Walls rise WALL_HEIGHT above this.
  const floor = heights[cx + cy * TILE_SIZE];
  const wallY = floor + WALL_HEIGHT;

  // South-facing doorway: middle cell of the south edge.
  const doorX = cx;
  const doorY = y1;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const onPerimeter =
        x === x0 || x === x1 || y === y0 || y === y1;
      if (!onPerimeter) continue;
      if (x === doorX && y === doorY) continue;

      const idx = x + y * TILE_SIZE;
      heights[idx]   = wallY;
      opens[idx]     = 0;
      kinds[idx]     = BOUNDARY_KIND_STONE; // suppress forest decoration
      materials[idx] = woodMaterialId;
    }
  }

  // Make sure the doorway is tagged open in case the chamber's openMask had
  // a stray closed pixel right at the door cell.
  const dIdx = doorX + doorY * TILE_SIZE;
  opens[dIdx] = 1;
  kinds[dIdx] = BOUNDARY_KIND_OPEN;
  heights[dIdx] = floor;
}
