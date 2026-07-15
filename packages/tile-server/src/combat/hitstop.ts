/**
 * Hitstop freeze set (T-296) — pure derivation of "which entities are frozen
 * this tick" from every actor's `ActiveActions` scratch, consumed by
 * `PhysicsSystem` to hold position/velocity for the freeze window.
 *
 * No new component: the freeze state lives entirely in the attacker's own
 * `weapon_trace` resolver scratch (`TraceScratch.hitStopUntilTick` for the
 * attacker itself, `hitStopTargets[]` for everyone it hit this swing) — this
 * function just walks every entity's slots and unions the still-live entries
 * into a Set. Pure and side-effect-free so it's independently unit-testable
 * (mirrors `pickAimAssistTarget`'s pure-function shape).
 */
import type { World } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import { ActiveActions } from "../components/action.ts";

interface TraceScratchShape {
  hitStopUntilTick?: number;
  hitStopTargets?: { entityId: string; untilTick: number }[];
}

/**
 * Every entity frozen at `serverTick` — either because its own slot's action
 * carries a live `hitStopUntilTick` (it just landed a hit), or because
 * another actor's swing scratch names it as a still-frozen target.
 */
export function collectHitStopFreezes(
  world: World,
  content: ContentService,
  serverTick: number,
): Set<EntityId> {
  const frozen = new Set<EntityId>();
  for (const { entityId, activeActions } of world.query(ActiveActions)) {
    for (const state of Object.values(activeActions.states)) {
      const def = content.actions.get(state.actionId);
      if (!def || !def.hitStopTicks) continue;
      const scratch = state.scratch as TraceScratchShape | undefined;
      if (!scratch) continue;
      if (scratch.hitStopUntilTick !== undefined && scratch.hitStopUntilTick > serverTick) {
        frozen.add(entityId);
      }
      if (scratch.hitStopTargets) {
        for (const t of scratch.hitStopTargets) {
          if (t.untilTick > serverTick) frozen.add(t.entityId as EntityId);
        }
      }
    }
  }
  return frozen;
}
