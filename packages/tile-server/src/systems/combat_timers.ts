import type { World } from "@voxim/engine";
import { ACTION_BLOCK, hasAction } from "@voxim/protocol";
import type { System, EventEmitter } from "../system.ts";
import { InputState } from "../components/game.ts";
import { Staggered, BlockHeld } from "../components/combat.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("CombatTimersSystem");

/**
 * CombatTimersSystem — the residual combat-counter bookkeeping that hasn't
 * yet been absorbed into the action runtime (T-229 shrank this from the old
 * DodgeSystem; it dies entirely once T-232 turns Staggered into a
 * hit-react action and T-233 makes block a primary-slot action).
 *
 * Two remaining responsibilities:
 *   - decrement `Staggered`, removing it on the tick it reaches 0;
 *   - maintain the `BlockHeld` tick counter (parry-window detection in
 *     health_hit_handler) while ACTION_BLOCK is held.
 *
 * Dodge (impulse, i-frames, stamina, the velocity lock) is no longer here —
 * it is the `dodge_roll` action's effects + `movement: "locked"` phase
 * (T-229). Each counter stays its own presence-as-flag component; absence
 * is the zero state, gated elsewhere via `world.has(id, Staggered)`.
 */
export class CombatTimersSystem implements System {
  /** Reads InputState written by NpcAi via world.write(); must precede. */
  readonly dependsOn = ["NpcAiSystem"];

  run(world: World, _events: EventEmitter, _dt: number): void {
    for (const { entityId, inputState } of world.query(InputState)) {
      // ── Decrement Staggered ────────────────────────────────────────────
      const staggered = world.get(entityId, Staggered);
      if (staggered) {
        const next = staggered.ticksRemaining - 1;
        if (next <= 0) {
          world.remove(entityId, Staggered);
          log.debug("stagger cleared: entity=%s", entityId);
        } else {
          world.set(entityId, Staggered, { ticksRemaining: next });
        }
      }

      // ── Maintain BlockHeld counter ─────────────────────────────────────
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
