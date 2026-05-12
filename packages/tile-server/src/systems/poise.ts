/**
 * PoiseSystem — ticks the staggering resource each frame (T-197).
 *
 * Reads game_config.combat.poise for tuning. Hit handlers are the only
 * source of poise damage; this system only handles the recovery half:
 *
 *   - If `regenDisabledTicks > 0`, decrement it. No regen this tick.
 *   - Else, regen `current` toward `max` at `regenPerSec * dt`.
 *
 * The actual stagger event (`event.stagger.light` / `event.stagger.heavy`)
 * fires inside the hit handler at the moment poise hits zero — see
 * health_hit_handler.ts. PoiseSystem is the regen loop only.
 */

import type { World } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { Poise } from "../components/combat.ts";

export class PoiseSystem implements System {
  /** No system dependencies — regen and disable countdown are pure local state. */
  readonly dependsOn = [];

  constructor(private readonly content: ContentService) {}

  run(world: World, _events: EventEmitter, dt: number): void {
    const cfg = this.content.getGameConfig().combat.poise;

    for (const { entityId, poise } of world.query(Poise)) {
      if (poise.regenDisabledTicks > 0) {
        world.set(entityId, Poise, { ...poise, regenDisabledTicks: poise.regenDisabledTicks - 1 });
        continue;
      }
      if (poise.current >= poise.max) continue;
      const next = Math.min(poise.max, poise.current + cfg.regenPerSec * dt);
      world.set(entityId, Poise, { ...poise, current: next });
    }
  }
}
