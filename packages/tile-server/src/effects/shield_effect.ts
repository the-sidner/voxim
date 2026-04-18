/**
 * Shield effect.
 *
 *   apply: stored as an ActiveEffect on the caster. magnitude represents
 *     absorbable HP. ticksRemaining decrements normally via BuffSystem.
 *
 *   incomingHook: when the holder takes damage, the shield absorbs up to
 *     `magnitude` HP. Remaining magnitude updates in place; if drained
 *     to zero, ticksRemaining is set to 0 so BuffSystem reaps it.
 */
import { ActiveEffects } from "../components/lore_loadout.ts";
import type { EffectApplyContext, EffectApplyHandler } from "./effect_handler.ts";
import type { IncomingDamageContext, IncomingDamageHook } from "./damage_hook.ts";
import { addActiveEffect } from "./util.ts";

const ID = "shield";

export const shieldEffectApply: EffectApplyHandler = {
  id: ID,
  apply(ctx: EffectApplyContext): void {
    const { world, casterId, entry, magnitude } = ctx;
    addActiveEffect(world, casterId, {
      effectStat: ID,
      magnitude,
      ticksRemaining: entry.durationTicks,
      sourceEntityId: casterId,
    });
  },
};

export const shieldIncomingHook: IncomingDamageHook = {
  id: ID,
  apply(ctx: IncomingDamageContext): number {
    const idx = ctx.targetEffects.effects.findIndex((e) => e.effectStat === ID);
    if (idx === -1) return ctx.incomingDamage;
    const shield = ctx.targetEffects.effects[idx];
    const absorbed = Math.min(shield.magnitude, ctx.incomingDamage);
    const remaining = shield.magnitude - absorbed;
    const updated = remaining > 0
      ? ctx.targetEffects.effects.map((e, i) =>
          i === idx ? { ...e, magnitude: remaining } : e
        )
      : ctx.targetEffects.effects.map((e, i) =>
          i === idx ? { ...e, ticksRemaining: 0 } : e
        );
    ctx.world.set(ctx.targetId, ActiveEffects, { effects: updated });
    return ctx.incomingDamage - absorbed;
  },
};
