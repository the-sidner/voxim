/**
 * Health effect handler — instant heal, instant damage, drain, and DoT/HoT.
 *
 * Apply:
 *   self targeting:        instant heal by `magnitude` (capped at Health.max)
 *   entity/area + duration: DoT applied to each target (tickDeltaPerSec = -magnitude)
 *   entity/area + instant:  damage to each target; optional drain back to caster
 *
 * Tick: applies `tickDeltaPerSec × dt` to Health for DoT/HoT effects. Publishes
 * DamageDealt when delta is negative, destroys entity on HP <= 0.
 */
import { TileEvents } from "@voxim/protocol";
import { Health } from "../components/game.ts";
import type {
  EffectApplyContext,
  EffectApplyHandler,
  EffectTickContext,
  EffectTickHandler,
} from "./effect_handler.ts";
import { addActiveEffect, nearestTarget, targetsInRange } from "./util.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("HealthEffect");

export const healthEffectApply: EffectApplyHandler = {
  id: "health",
  apply(ctx: EffectApplyContext): void {
    const { world, events, casterId, casterX, casterY, entry, magnitude, spatial, overrideTargetId, deaths } = ctx;

    if (entry.targeting === "self") {
      const health = world.get(casterId, Health);
      if (health) {
        const newHp = Math.min(health.max, health.current + magnitude);
        log.debug("instant heal: entity=%s +%.1f hp (%.1f→%.1f)", casterId, magnitude, health.current, newHp);
        world.set(casterId, Health, { ...health, current: newHp });
      }
      return;
    }

    // For entity/area targeting: resolve targets (or use override from strike hit).
    const targets = overrideTargetId !== null
      ? [overrideTargetId]
      : entry.targeting === "area"
        ? targetsInRange(world, spatial, casterId, casterX, casterY, entry.range)
        : (() => {
            const t = nearestTarget(world, spatial, casterId, casterX, casterY, entry.range);
            return t ? [t] : [];
          })();

    for (const targetId of targets) {
      if (entry.durationTicks > 0) {
        log.debug("dot applied: target=%s dps=%.2f ticks=%d", targetId, magnitude, entry.durationTicks);
        addActiveEffect(world, targetId, {
          effectStat: "health",
          magnitude,
          ticksRemaining: entry.durationTicks,
          sourceEntityId: casterId,
          tickDeltaPerSec: -magnitude,
        });
        continue;
      }

      const targetHealth = world.get(targetId, Health);
      if (!targetHealth) continue;
      const stolen = Math.min(magnitude, targetHealth.current);
      const newTargetHP = targetHealth.current - stolen;
      world.set(targetId, Health, { ...targetHealth, current: newTargetHP });
      events.publish(TileEvents.DamageDealt, { targetId, sourceId: casterId, amount: stolen, blocked: false });
      log.debug("instant damage: caster=%s target=%s dmg=%.1f drain=%s", casterId, targetId, stolen, entry.drainToCaster);
      if (newTargetHP <= 0) {
        deaths.request({ entityId: targetId, killerId: casterId, cause: "effect" });
      }
      if (entry.drainToCaster) {
        const casterHealth = world.get(casterId, Health);
        if (casterHealth) {
          world.set(casterId, Health, {
            ...casterHealth,
            current: Math.min(casterHealth.max, casterHealth.current + stolen),
          });
        }
      }
    }
  },
};

export const healthEffectTick: EffectTickHandler = {
  id: "health",
  tick(ctx: EffectTickContext): void {
    const { world, events, entityId, effect, dt, deaths } = ctx;
    if (effect.tickDeltaPerSec === undefined) return;

    const delta = effect.tickDeltaPerSec * dt;
    const health = world.get(entityId, Health);
    if (!health) return;

    const newHP = Math.max(0, health.current + delta);
    world.set(entityId, Health, { ...health, current: newHP });

    if (delta < 0) {
      log.debug("dot tick: entity=%s delta=%.3f hp=%.1f", entityId, delta, newHP);
      events.publish(TileEvents.DamageDealt, {
        targetId: entityId,
        sourceId: effect.sourceEntityId,
        amount: -delta,
        blocked: false,
      });
    }
    if (newHP <= 0) {
      log.info("entity died from effect: entity=%s source=%s", entityId, effect.sourceEntityId);
      deaths.request({ entityId, killerId: effect.sourceEntityId, cause: "effect" });
    }
  },
};
