/**
 * Generic skill effect resolvers (T-239 phase 2b) — the five bespoke
 * handler files (health/speed/damage_boost/shield + the consume-on-use
 * damage hooks) are gone. These are thin, generic, registry-dispatched
 * (the CLAUDE.md doctrine — registry over content id, never a hardcoded
 * switch): a stat-modifier effect is a buff scene-graph child; instant
 * health is a direct delta. No `ActiveEffects`, no `BuffSystem`.
 *
 * Accepted retunes (structure over parity — documented in
 * STATUS_MODIFIER_PLAN.md):
 *   - damage_boost: consume-on-use → a short timed `damageDealt` mul buff
 *     (matrix entries have durationTicks 0; defaulted to DAMAGE_BOOST_TICKS).
 *   - shield: flat HP absorb → a timed fractional `damageTaken` mul.
 *   - health DoT: tickDeltaPerSec×dt → a per-tick delta (tickDelta).
 */

import { TileEvents } from "@voxim/protocol";
import { Health } from "../components/game.ts";
import type { EffectApplyContext, EffectApplyHandler } from "./effect_handler.ts";
import { spawnBuffChild } from "../actions/resolvers/buff.ts";
import { nearestTarget, targetsInRange } from "./util.ts";

/** damage_boost matrix entries are durationTicks:0 (was consume-on-use). */
const DAMAGE_BOOST_TICKS = 60;

function clamp(lo: number, hi: number, v: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export const speedApply: EffectApplyHandler = {
  id: "speed",
  apply(ctx: EffectApplyContext): void {
    spawnBuffChild(
      ctx.world, ctx.casterId,
      { stat: "moveSpeed", op: "mul", value: 1 + ctx.magnitude, tickDelta: 0 },
      ctx.entry.durationTicks || 1,
    );
  },
};

export const damageBoostApply: EffectApplyHandler = {
  id: "damage_boost",
  apply(ctx: EffectApplyContext): void {
    spawnBuffChild(
      ctx.world, ctx.casterId,
      { stat: "damageDealt", op: "mul", value: 1 + ctx.magnitude, tickDelta: 0 },
      ctx.entry.durationTicks > 0 ? ctx.entry.durationTicks : DAMAGE_BOOST_TICKS,
    );
  },
};

export const shieldApply: EffectApplyHandler = {
  id: "shield",
  apply(ctx: EffectApplyContext): void {
    // Stronger shield magnitude → more incoming-damage mitigation.
    const factor = clamp(0.2, 0.95, 1 - ctx.magnitude / 100);
    spawnBuffChild(
      ctx.world, ctx.casterId,
      { stat: "damageTaken", op: "mul", value: factor, tickDelta: 0 },
      ctx.entry.durationTicks || 1,
    );
  },
};

export const healthApply: EffectApplyHandler = {
  id: "health",
  apply(ctx: EffectApplyContext): void {
    const { world, events, casterId, casterX, casterY, entry, magnitude, spatial, overrideTargetId, deaths } = ctx;

    if (entry.targeting === "self") {
      const health = world.get(casterId, Health);
      if (health) {
        world.set(casterId, Health, {
          ...health,
          current: Math.min(health.max, health.current + magnitude),
        });
      }
      return;
    }

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
        // DoT: a health buff child whose per-tick delta drains the target.
        spawnBuffChild(
          world, targetId,
          { stat: "health", op: "add", value: 0, tickDelta: -magnitude },
          entry.durationTicks,
        );
        continue;
      }
      const targetHealth = world.get(targetId, Health);
      if (!targetHealth) continue;
      const stolen = Math.min(magnitude, targetHealth.current);
      const next = targetHealth.current - stolen;
      world.set(targetId, Health, { ...targetHealth, current: next });
      events.publish(TileEvents.DamageDealt, { targetId, sourceId: casterId, amount: stolen, blocked: false });
      if (next <= 0) deaths.request({ entityId: targetId, killerId: casterId, cause: "effect" });
      if (entry.drainToCaster) {
        const ch = world.get(casterId, Health);
        if (ch) world.set(casterId, Health, { ...ch, current: Math.min(ch.max, ch.current + stolen) });
      }
    }
  },
};
