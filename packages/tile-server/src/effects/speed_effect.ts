/**
 * Speed effect — contributes a movement speed bonus via the compose registry.
 *
 * Apply: adds a timed ActiveEffect on the caster.
 * Compose: each active speed effect contributes its magnitude as speedBonus;
 *   BuffSystem sums contributions and multiplies the EncumbrancePenalty base
 *   to produce the final SpeedModifier.
 */
import type {
  EffectApplyContext,
  EffectApplyHandler,
  EffectComposeHandler,
  EffectContribution,
} from "./effect_handler.ts";
import type { ActiveEffect } from "../components/lore_loadout.ts";
import { addActiveEffect } from "./util.ts";

export const speedEffectApply: EffectApplyHandler = {
  id: "speed",
  apply(ctx: EffectApplyContext): void {
    const { world, casterId, entry, magnitude } = ctx;
    addActiveEffect(world, casterId, {
      effectStat: "speed",
      magnitude,
      ticksRemaining: entry.durationTicks,
      sourceEntityId: casterId,
    });
  },
};

export const speedEffectCompose: EffectComposeHandler = {
  id: "speed",
  contribute(effect: ActiveEffect): EffectContribution {
    return { speedBonus: effect.magnitude };
  },
};
