/**
 * Damage boost effect — stored as an ActiveEffect and consumed by
 * HealthHitHandler on the caster's next melee hit.
 *
 * Uses the "consume on use" expiry policy: the effect does not tick down and
 * is removed on first use. BuffSystem skips ticks decrement for such effects
 * via `isConsumeOnUse()`.
 */
import type { EffectApplyContext, EffectApplyHandler } from "./effect_handler.ts";
import { CONSUME_ON_USE_SENTINEL } from "../components/lore_loadout.ts";
import { addActiveEffect } from "./util.ts";

export const damageBoostEffectApply: EffectApplyHandler = {
  id: "damage_boost",
  apply(ctx: EffectApplyContext): void {
    const { world, casterId, magnitude } = ctx;
    addActiveEffect(world, casterId, {
      effectStat: "damage_boost",
      magnitude,
      ticksRemaining: CONSUME_ON_USE_SENTINEL,
      sourceEntityId: casterId,
    });
  },
};
