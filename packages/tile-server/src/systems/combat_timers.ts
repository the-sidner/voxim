import type { World } from "@voxim/engine";
import { ACTION_BLOCK, hasAction } from "@voxim/protocol";
import type { System, EventEmitter } from "../system.ts";
import { InputState } from "../components/game.ts";
import { BlockHeld } from "../components/combat.ts";

/**
 * CombatTimersSystem — the last residual combat-counter bookkeeping not yet
 * absorbed into the action runtime. T-229 shrank this from DodgeSystem;
 * T-232 removed the Staggered countdown (stagger is now a reaction action
 * whose `play` phase duration *is* the stagger window, with a `staggered`
 * tag for the lockout). The single remaining job:
 *
 *   - maintain the `BlockHeld` tick counter (parry-window detection in
 *     health_hit_handler) while ACTION_BLOCK is held.
 *
 * This system dies entirely at T-233, when block becomes a primary-slot
 * action and the parry window is read from that action's phase instead.
 */
export class CombatTimersSystem implements System {
  /** Reads InputState written by NpcAi via world.write(); must precede. */
  readonly dependsOn = ["NpcAiSystem"];

  run(world: World, _events: EventEmitter, _dt: number): void {
    for (const { entityId, inputState } of world.query(InputState)) {
      const blocking = hasAction(inputState.actions, ACTION_BLOCK);
      const cur = world.get(entityId, BlockHeld);
      if (blocking) {
        world.set(entityId, BlockHeld, { ticks: (cur?.ticks ?? 0) + 1 });
      } else if (cur) {
        world.remove(entityId, BlockHeld);
      }
    }
  }
}
