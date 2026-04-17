import type { World } from "@voxim/engine";
import type { Registry } from "@voxim/engine";
import type { System, EventEmitter } from "../system.ts";
import { ActiveEffects, isConsumeOnUse } from "../components/lore_loadout.ts";
import type { ActiveEffect } from "../components/lore_loadout.ts";
import { SpeedModifier, EncumbrancePenalty } from "../components/world.ts";
import type {
  EffectTickHandler,
  EffectComposeHandler,
} from "../effects/effect_handler.ts";
import type { DeathRequestPort } from "../events/death.ts";

/**
 * BuffSystem — iterates ActiveEffects each tick.
 *
 *   1. For every effect, invoke its tick handler (if any). Health DoTs/HoTs live
 *      here; cosmetic buffs (speed, damage_boost, shield) need no tick handler.
 *   2. For every effect, invoke its compose handler (if any). Speed effects
 *      contribute a speedBonus; future stats (damage mult, armor) plug into the
 *      same compose pass.
 *   3. Decrement ticksRemaining unless the effect is `consume on use`.
 *   4. Write final SpeedModifier = EncumbrancePenalty × (1 + Σ speedBonus).
 *
 * Single writer of SpeedModifier: no other system composes speed. The tick →
 * compose → decrement loop is generic; no `effectStat ===` branches remain.
 */
export class BuffSystem implements System {
  constructor(
    private readonly tickRegistry: Registry<EffectTickHandler>,
    private readonly composeRegistry: Registry<EffectComposeHandler>,
    private readonly deaths: DeathRequestPort,
  ) {}

  run(world: World, events: EventEmitter, dt: number): void {
    for (const { entityId, activeEffects } of world.query(ActiveEffects)) {
      if (activeEffects.effects.length === 0) continue;

      const surviving: ActiveEffect[] = [];
      let speedBonus = 0;

      for (const effect of activeEffects.effects) {
        if (effect.ticksRemaining === 0) continue;

        if (this.tickRegistry.has(effect.effectStat)) {
          this.tickRegistry.get(effect.effectStat).tick({
            world, events, entityId, effect, dt, deaths: this.deaths,
          });
        }

        if (this.composeRegistry.has(effect.effectStat)) {
          const c = this.composeRegistry.get(effect.effectStat).contribute(effect);
          if (c.speedBonus) speedBonus += c.speedBonus;
        }

        const nextTicks = isConsumeOnUse(effect) ? effect.ticksRemaining : effect.ticksRemaining - 1;
        if (nextTicks > 0) {
          surviving.push({ ...effect, ticksRemaining: nextTicks });
        }
      }

      // Compose final SpeedModifier: encumbrance base × all speed buff bonuses.
      // This is the only place SpeedModifier is written — single writer, no conflicts.
      const encumbranceBase = world.get(entityId, EncumbrancePenalty)?.multiplier ?? 1.0;
      const composed = encumbranceBase * (1 + speedBonus);
      world.set(entityId, SpeedModifier, { multiplier: composed });

      world.set(entityId, ActiveEffects, { effects: surviving });
    }
  }
}
