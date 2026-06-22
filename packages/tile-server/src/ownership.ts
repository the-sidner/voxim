/**
 * Workstation ownership + base capture (T-082).
 *
 * When a player deploys a workstation (any entity carrying a `WorkstationTag`),
 * two things happen:
 *
 *   1. STAMP — the new workstation is stamped with the placer's dynasty
 *      (`Heritage.dynastyId`) via `WorkbenchOwner`.
 *
 *   2. CAPTURE — every existing owned workstation within
 *      `building.capture.radiusWorldUnits` whose dynasty differs from the
 *      placer's is re-stamped to the placer's dynasty. Placing your own
 *      workbench inside an enemy base claims the surrounding owned
 *      structures — the management half of "destroy-and-replace" capture.
 *
 * Driven by the `EntityDeployed` event subscriber in server.ts. State changes
 * use `world.write` (immediate) because the subscriber runs post-changeset,
 * out of the tick's deferred window — the same stance spawning takes.
 */

import type { World } from "@voxim/engine";
import type { EntityDeployedPayload } from "@voxim/protocol";
import { Heritage } from "./components/heritage.ts";
import { Position } from "./components/game.ts";
import { WorkstationTag } from "./components/building.ts";
import { BuiltBy, WorkbenchOwner } from "./components/workbench.ts";

export interface CapturedStructure {
  entityId: string;
  /** Dynasty that owned it before this deploy. */
  previousDynastyId: string;
}

export interface CaptureResult {
  /** Dynasty the new workstation (and any captured ones) now belongs to. */
  dynastyId: string;
  /** Structures re-stamped to the placer's dynasty by this deploy. */
  captured: CapturedStructure[];
}

/**
 * Stamp ownership on a freshly deployed workstation and capture nearby
 * enemy-owned workstations. No-op (returns null) when the deployed entity is
 * not a workstation or the placer has no dynasty. `captureRadius` is in world
 * units; pass `building.capture.radiusWorldUnits`.
 */
export function stampOwnershipAndCapture(
  world: World,
  payload: EntityDeployedPayload,
  captureRadius: number,
): CaptureResult | null {
  const { placerId, entityId, worldX, worldY } = payload;

  // Only workstations carry management-layer ownership.
  if (!world.has(entityId, WorkstationTag)) return null;

  const dynastyId = world.get(placerId, Heritage)?.dynastyId;
  if (!dynastyId) return null;

  // 1. Stamp the new workstation's current owner, and — once, never overwritten
  //    — its founding dynasty (T-083). Capture below re-stamps WorkbenchOwner
  //    but leaves BuiltBy intact, so a seized base keeps its founders' mark.
  world.write(entityId, WorkbenchOwner, { dynastyId });
  if (!world.has(entityId, BuiltBy)) world.write(entityId, BuiltBy, { dynastyId });

  // 2. Capture nearby enemy-owned workstations.
  const r2 = captureRadius * captureRadius;
  const captured: CapturedStructure[] = [];
  for (const { entityId: otherId, workbenchOwner } of world.query(WorkbenchOwner)) {
    if (otherId === entityId) continue;
    if (workbenchOwner.dynastyId === dynastyId) continue; // already ours
    const pos = world.get(otherId, Position);
    if (!pos) continue;
    const dx = pos.x - worldX;
    const dy = pos.y - worldY;
    if (dx * dx + dy * dy > r2) continue;
    world.write(otherId, WorkbenchOwner, { dynastyId });
    captured.push({ entityId: otherId, previousDynastyId: workbenchOwner.dynastyId });
  }

  return { dynastyId, captured };
}
