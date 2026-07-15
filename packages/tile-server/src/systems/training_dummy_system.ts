/**
 * TrainingDummySystem (T-327) — auto-heal for the combat-feel tuning
 * pipeline's practice target.
 *
 * The dummy is prevented from ever reaching lethal at the damage-application
 * site (`health_hit_handler.ts` floors its Health at 1 for any entity
 * carrying `TrainingDummy` — DeathSystem's composed-lethal sweep reads
 * committed `Health.current <= 0`, so the floor has to happen where damage
 * is written, not here). This system's only job is the *recovery*: detect a
 * tick-over-tick drop in Health.current (a hit just landed), and once
 * `healDelayTicks` pass with no further drop, snap back to full — so a
 * practice session doesn't need a respawn between swings.
 *
 * Single writer of both `Health` (for TrainingDummy entities only) and
 * `TrainingDummy`'s own tracking fields.
 */
import type { World } from "@voxim/engine";
import type { System, EventEmitter } from "../system.ts";
import { Health } from "../components/game.ts";
import { TrainingDummy } from "../components/training_dummy.ts";

export class TrainingDummySystem implements System {
  private serverTick = 0;

  /** Dev-only, like its sibling DebugCommandSystem — the dummy is a tuning
   *  aid; production ticks skip the query entirely. */
  constructor(private readonly devMode: boolean) {}

  prepare(serverTick: number): void {
    this.serverTick = serverTick;
  }

  run(world: World, _events: EventEmitter, _dt: number): void {
    if (!this.devMode) return;
    for (const { entityId, trainingDummy } of world.query(TrainingDummy)) {
      const health = world.get(entityId, Health);
      if (!health) continue;

      if (health.current < trainingDummy.lastObservedHealth) {
        // A hit landed since we last looked — restart the heal-delay clock.
        world.set(entityId, TrainingDummy, {
          ...trainingDummy,
          lastHitTick: this.serverTick,
          lastObservedHealth: health.current,
        });
        continue;
      }

      if (health.current < health.max && this.serverTick - trainingDummy.lastHitTick >= trainingDummy.healDelayTicks) {
        world.mutate(entityId, Health, (h) => ({ ...h, current: h.max }));
        world.set(entityId, TrainingDummy, { ...trainingDummy, lastObservedHealth: health.max });
      } else if (health.current !== trainingDummy.lastObservedHealth) {
        world.set(entityId, TrainingDummy, { ...trainingDummy, lastObservedHealth: health.current });
      }
    }
  }
}
