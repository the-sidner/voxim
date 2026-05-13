/**
 * Stair entity spawn helper (T-213 v2, ported to LevelDef in T-214).
 *
 * Walks `level.edges.stairs` and spawns one `stair` prefab per edge at
 * the anchor pixel, facing into the wilderness plateau. The stair is a
 * visible voxel staircase — the heightmap ramp from `applyStairUnlock`
 * is the actual walkable surface for "found" stairs; the prop sits on
 * top of it as decoration.
 *
 * Found stairs (`locked === null`) spawn at path-floor height; the
 * ramp underneath makes the climb walkable. Locked stairs spawn at
 * the same height but the wilderness wall stays a 2u step, so the
 * player sees the stair but can't pass — the visual contract is
 * "stairs here, locked". The future StairUnlockSystem (T-212 v2)
 * flips lock state when the player consumes the gating trinket and
 * applies the heightmap ramp at runtime.
 */

import type { World } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import { findRegion, type LevelDef } from "@voxim/atlas";
import { Facing } from "./components/game.ts";
import { Stair } from "./components/stair.ts";
import { spawnPrefab } from "./spawner.ts";

const STAIR_FOUND_PREFAB_ID  = "stair";
const STAIR_LOCKED_PREFAB_ID = "stair_locked";

export function placeStairs(
  world: World,
  content: ContentService,
  level: LevelDef,
  heightBuffer: Float32Array,
  tileSize: number,
): number {
  for (const id of [STAIR_FOUND_PREFAB_ID, STAIR_LOCKED_PREFAB_ID]) {
    if (!content.prefabs.get(id)) {
      console.warn(`[stair_spawner] missing prefab "${id}" — skipping stair spawn`);
      return 0;
    }
  }
  const stairs = level.edges.stairs;
  if (!stairs.length) return 0;

  const tilePixelsPerAtlasPixel = tileSize / level.gridSize;
  let placed = 0;
  let skipped = 0;
  let found = 0, locked = 0;

  for (const stair of stairs) {
    const fromRegion = findRegion(level, stair.from);
    const toRegion   = findRegion(level, stair.to);
    if (!fromRegion || !toRegion) { skipped++; continue; }
    if (stair.climbDir.dx === 0 && stair.climbDir.dy === 0) { skipped++; continue; }

    const ax = Math.floor(stair.anchorPixel.x * tilePixelsPerAtlasPixel);
    const ay = Math.floor(stair.anchorPixel.y * tilePixelsPerAtlasPixel);
    if (ax < 0 || ay < 0 || ax >= tileSize || ay >= tileSize) { skipped++; continue; }

    // Facing convention matches `Math.sin(facing)/Math.cos(facing) =
    // (forward.x, forward.y)` used elsewhere in tile-server. Model's
    // forward axis is +Y, so at facing=0 the stair climbs in +world.y.
    const facing = Math.atan2(stair.climbDir.dx, stair.climbDir.dy);

    // Sit the stair's base voxels on top of the path floor at the anchor.
    // The heightBuffer at the anchor still reads the original floor height
    // even after applyStairUnlock — its ramp lerp starts at t=0 (anchor) and
    // climbs into the wilderness side. Locked stairs skip the ramp entirely,
    // so the anchor's path-floor height is correct either way.
    const floorZ = heightBuffer[ay * tileSize + ax];

    const isLocked = stair.locked !== null;
    const prefabId = isLocked ? STAIR_LOCKED_PREFAB_ID : STAIR_FOUND_PREFAB_ID;
    const id = spawnPrefab(world, content, prefabId, {
      x: ax,
      y: ay,
      z: floorZ,
      facing,
      seed: hash32(stair.id),
    });
    world.write(id, Facing, { angle: facing });
    world.write(id, Stair, {
      stairId:    stair.id,
      toZoneId:   toRegion.zoneId,
      fromZoneId: fromRegion.zoneId,
      trinketId:  stair.locked?.trinketId ?? "",
      anchorX:    ax,
      anchorY:    ay,
      unlocked:   !isLocked,
    });
    placed++;
    if (isLocked) locked++; else found++;
  }

  console.log(
    `[stair_spawner] placed ${placed} stair entities ` +
    `(skipped=${skipped}, found=${found}, locked=${locked})`,
  );
  return placed;
}

function hash32(s: string): number {
  let h = 0x811C9DC5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
