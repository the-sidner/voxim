/**
 * Heir spawn resolution (T-079).
 *
 * On death the session survives and `respawnPlayer` spawns the heir. WHERE the
 * heir lands depends on the dynasty's hearth (the family workbench):
 *
 *   - hearth anchored on THIS tile AND still standing → spawn at the hearth.
 *   - hearth anchored on THIS tile but DESTROYED → displaced to the default
 *     spawn in a weakened state (the heir lost their seat of power).
 *   - no hearth on this tile (fresh dynasty, or hearth lives elsewhere) →
 *     default spawn, full strength.
 *
 * The hearth anchor is account-side state (`SessionInfo.hearthAnchor`, set on
 * deploy); "still standing" is derived from LIVE world state — a `WorkstationTag`
 * entity near the anchor position — so no save-format or destroy-event plumbing
 * is needed: if the hearth entity is gone from the world, the heir is displaced.
 *
 * Pure + dependency-light so it is unit-testable without the QUIC/session stack.
 */

import type { World } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import type { HearthAnchor } from "./account_client.ts";
import { Position } from "./components/game.ts";
import { WorkstationTag } from "./components/building.ts";

export interface HeirSpawn {
  x: number;
  y: number;
  /** Undefined → spawner samples terrain height (matches the default-spawn path). */
  z: number | undefined;
  /** True when the hearth was destroyed → spawn injured + below max health. */
  weakened: boolean;
  /** True when spawning at the standing hearth (the happy path). */
  atHearth: boolean;
}

/** Is a live workstation entity within `radius` (horizontal) of `pos`? */
function hasWorkstationNear(
  world: World,
  pos: { x: number; y: number },
  radius: number,
): boolean {
  const r2 = radius * radius;
  for (const { position } of world.query(Position, WorkstationTag)) {
    const dx = position.x - pos.x;
    const dy = position.y - pos.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

/**
 * Decide an heir's spawn point + weakened flag from the dynasty's hearth anchor
 * and the live world. See the module docstring for the three cases.
 */
export function resolveHeirSpawn(
  world: World,
  content: ContentService,
  hearthAnchor: HearthAnchor | null,
  tileId: string,
): HeirSpawn {
  const spawn = content.getGameConfig().player;
  const onThisTile = !!hearthAnchor && hearthAnchor.tileId === tileId;

  if (!onThisTile) {
    // Fresh dynasty or hearth on another tile → ordinary spawn, full strength.
    return { x: spawn.defaultSpawnX, y: spawn.defaultSpawnY, z: undefined, weakened: false, atHearth: false };
  }

  const radius = spawn.hearthDetectRadius ?? 3;
  if (hasWorkstationNear(world, hearthAnchor!.position, radius)) {
    const p = hearthAnchor!.position;
    return { x: p.x, y: p.y, z: p.z, weakened: false, atHearth: true };
  }

  // Anchor exists here but the hearth is gone → displaced + weakened.
  return { x: spawn.defaultSpawnX, y: spawn.defaultSpawnY, z: undefined, weakened: true, atHearth: false };
}
