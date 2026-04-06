import type { World } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { System, EventEmitter } from "../system.ts";
import { Health } from "../components/game.ts";
import { ActiveEffects, CONSUME_ON_USE_SENTINEL } from "../components/lore_loadout.ts";
import type { ActiveEffect } from "../components/lore_loadout.ts";
import { SpeedModifier } from "../components/world.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("BuffSystem");

export class BuffSystem implements System {
  run(world: World, events: EventEmitter, dt: number): void {
    for (const { entityId, activeEffects } of world.query(ActiveEffects)) {
      if (activeEffects.effects.length === 0) continue;

      const surviving: ActiveEffect[] = [];
      let speedBonus = 0;

      for (const effect of activeEffects.effects) {
        if (effect.ticksRemaining === 0) continue;

        if (effect.effectStat === "health" && effect.tickDeltaPerSec !== undefined) {
          const delta = effect.tickDeltaPerSec * dt;
          const health = world.get(entityId, Health);
          if (health) {
            const newHP = Math.max(0, health.current + delta);
            world.set(entityId, Health, { ...health, current: newHP });
            if (delta < 0) {
              log.debug("dot tick: entity=%s effect=%s delta=%.3f hp=%.1f",
                entityId, effect.effectStat, delta, newHP);
              events.publish(TileEvents.DamageDealt, {
                targetId: entityId,
                sourceId: effect.sourceEntityId,
                amount: -delta,
                blocked: false,
              });
            }
            if (newHP <= 0) {
              log.info("entity died from effect: entity=%s effect=%s source=%s",
                entityId, effect.effectStat, effect.sourceEntityId);
              world.destroy(entityId);
              events.publish(TileEvents.EntityDied, { entityId, killerId: effect.sourceEntityId });
            }
          }
        } else if (effect.effectStat === "speed") {
          speedBonus += effect.magnitude;
        }

        const nextTicks = effect.ticksRemaining === CONSUME_ON_USE_SENTINEL
          ? CONSUME_ON_USE_SENTINEL
          : effect.ticksRemaining - 1;

        if (nextTicks === 0) {
          log.debug("effect expired: entity=%s effect=%s", entityId, effect.effectStat);
        }

        if (nextTicks > 0) {
          surviving.push({ ...effect, ticksRemaining: nextTicks });
        }
      }

      if (speedBonus > 0) {
        const mod = world.get(entityId, SpeedModifier) ?? { multiplier: 1.0 };
        world.set(entityId, SpeedModifier, { multiplier: mod.multiplier * (1 + speedBonus) });
      }

      world.set(entityId, ActiveEffects, { effects: surviving });
    }
  }
}
