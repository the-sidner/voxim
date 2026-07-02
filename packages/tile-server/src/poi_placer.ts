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
import { mulberry32 } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import { BoundaryKind } from "@voxim/protocol";
import { TILE_SIZE } from "@voxim/world";
import { spawnPrefab } from "./spawner.ts";

const WALL_HEIGHT = 2.0;

/** Pool of NPC prefab ids used by the mob POI.  Wired by id; kept lean for
 *  "first primitive". Boot-cross-checked in server.ts against content.prefabs
 *  (T-315 A6) — every id here is assumed loaded by the time spawnMobPois runs. */
export const MOB_NPC_POOL = ["wolf", "bandit", "archer", "drowner", "rotten_knight"] as const;

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

/** The four render-field planes a room POI de-natures for its footprint
 *  (indoor/worked ⇒ no forest fields). Same flat TILE_SIZE² indexing as
 *  `heights`/`opens`/`kinds`/`materials`. Stair ramps carve through
 *  wilderness too but are NOT covered here — their field divergence is
 *  accepted (see `applyStairUnlock`'s doc comment, T-315 A4). */
export interface RoomFieldPlanes {
  fertility: Uint8Array;
  wetness: Uint8Array;
  overgrowth: Uint8Array;
  traffic: Uint8Array;
}

/**
 * Place POIs for every chamber.  Mutates `heights` / `opens` / `kinds` /
 * `materials` in place for room POIs; returns a list of mob spawns for the
 * caller to instantiate after chunks are committed.
 *
 * `woodMaterialId` and `floorMaterialFallbackId` are tile-server's content
 * material ids (atlas-id translation has already happened by this point).
 *
 * `fields` are the atlas's derived render-field planes (T-311 P3) for the
 * SAME tile buffers — room POIs de-nature them under the stamped footprint
 * so a walled room doesn't keep reading the forest fertility/wetness it
 * replaced (T-315 A4).
 */
export function placePois(
  heights: Float32Array,
  opens: Uint8Array,
  kinds: Uint16Array,
  materials: Uint16Array,
  fields: RoomFieldPlanes,
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
      stampRoom(heights, opens, kinds, materials, fields, cx, cy, woodMaterialId);
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
 * Every `MOB_NPC_POOL` id is boot-cross-checked in server.ts (T-315 A6),
 * so no runtime existence guard is needed here.
 */
export function spawnMobPois(
  world: World,
  content: ContentService,
  mobs: MobSpawn[],
): void {
  for (const m of mobs) {
    spawnPrefab(world, content, m.prefabId, { x: m.x, y: m.y });
  }
}

/**
 * Stamp a small wooden-walled enclosure into the terrain buffers, with a
 * one-cell doorway gap on the south wall so the player can walk in.
 *
 * The room footprint is `(2*ROOM_HALF + 1)` cells per axis.  Walls form a
 * one-cell-thick perimeter; the interior stays open.
 *
 * De-natures `fields` (fertility/wetness/overgrowth→0, traffic→walked)
 * across the FULL footprint — walls AND interior — so the room reads as
 * indoor/worked rather than keeping the forest fields it replaced. Height/
 * open/kind/material stay wall-perimeter-only as before (T-315 A4).
 */
function stampRoom(
  heights: Float32Array,
  opens: Uint8Array,
  kinds: Uint16Array,
  materials: Uint16Array,
  fields: RoomFieldPlanes,
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
      const idx = x + y * TILE_SIZE;

      // Indoor/worked field de-naturing covers the whole footprint (walls
      // AND interior floor) — a walled room shouldn't keep reading the
      // forest fertility/wetness/overgrowth it replaced.
      fields.fertility[idx]  = 0;
      fields.wetness[idx]    = 0;
      fields.overgrowth[idx] = 0;
      fields.traffic[idx]    = 128; // moderate, walked-interior traffic

      const onPerimeter =
        x === x0 || x === x1 || y === y0 || y === y1;
      if (!onPerimeter) continue;
      if (x === doorX && y === doorY) continue;

      heights[idx]   = wallY;
      opens[idx]     = 0;
      kinds[idx]     = BoundaryKind.stone; // suppress forest decoration
      materials[idx] = woodMaterialId;
    }
  }

  // Make sure the doorway is tagged open in case the chamber's openMask had
  // a stray closed pixel right at the door cell.
  const dIdx = doorX + doorY * TILE_SIZE;
  opens[dIdx] = 1;
  kinds[dIdx] = BoundaryKind.open;
  heights[dIdx] = floor;
}
