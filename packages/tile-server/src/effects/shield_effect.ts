/**
 * Shield effect — stored as an ActiveEffect and consumed by HealthHitHandler
 * when the target takes damage. magnitude represents absorbable HP.
 *
 * No tick or compose behaviour; BuffSystem only decrements ticksRemaining.
 */
import type { EffectApplyContext, EffectApplyHandler } from "./effect_handler.ts";
import { addActiveEffect } from "./util.ts";

export const shieldEffectApply: EffectApplyHandler = {
  id: "shield",
  apply(ctx: EffectApplyContext): void {
    const { world, casterId, entry, magnitude } = ctx;
    addActiveEffect(world, casterId, {
      effectStat: "shield",
      magnitude,
      ticksRemaining: entry.durationTicks,
      sourceEntityId: casterId,
    });
  },
};
