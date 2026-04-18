/**
 * Damage boost effect.
 *
 *   apply: stored as an ActiveEffect on the caster. Uses the
 *     "consume on use" expiry policy — the effect does not tick down
 *     and is removed on first use. BuffSystem skips ticks decrement
 *     for such effects via `isConsumeOnUse()`.
 *
 *   outgoingHook: when the caster strikes, multiplies the outgoing
 *     damage by `1 + magnitude` and consumes the effect (sets its
 *     ticksRemaining to 0 so BuffSystem reaps it next tick).
 */
import { ActiveEffects, CONSUME_ON_USE_SENTINEL } from "../components/lore_loadout.ts";
import type { EffectApplyContext, EffectApplyHandler } from "./effect_handler.ts";
import type { OutgoingDamageContext, OutgoingDamageHook } from "./damage_hook.ts";
import { addActiveEffect } from "./util.ts";

const ID = "damage_boost";

export const damageBoostEffectApply: EffectApplyHandler = {
  id: ID,
  apply(ctx: EffectApplyContext): void {
    const { world, casterId, magnitude } = ctx;
    addActiveEffect(world, casterId, {
      effectStat: ID,
      magnitude,
      ticksRemaining: CONSUME_ON_USE_SENTINEL,
      sourceEntityId: casterId,
    });
  },
};

export const damageBoostOutgoingHook: OutgoingDamageHook = {
  id: ID,
  apply(ctx: OutgoingDamageContext): number {
    const idx = ctx.attackerEffects.effects.findIndex((e) => e.effectStat === ID);
    if (idx === -1) return 1.0;
    const boost = ctx.attackerEffects.effects[idx];
    const updated = ctx.attackerEffects.effects.map((e, i) =>
      i === idx ? { ...e, ticksRemaining: 0 } : e
    );
    ctx.world.set(ctx.attackerId, ActiveEffects, { effects: updated });
    return 1 + boost.magnitude;
  },
};
