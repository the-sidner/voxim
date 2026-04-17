import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { loreLoadoutCodec, activeEffectsCodec } from "@voxim/codecs";
import type { SkillVerb } from "@voxim/content";

/**
 * One equipped skill slot — a verb plus two fragment IDs.
 *   verb            — determines activation mode and targeting class
 *   outwardFragmentId — Fragment in position 1; its concept drives what the skill does
 *   inwardFragmentId  — Fragment in position 2; its concept drives the cost shape
 */
export interface LoreSkillSlot {
  verb: SkillVerb;
  /** ID of the internally-learned LoreFragment that fills position 1 (outward). */
  outwardFragmentId: string;
  /** ID of the internally-learned LoreFragment that fills position 2 (inward). */
  inwardFragmentId: string;
}

export interface LoreLoadoutData {
  /** Four equippable skill slots — null means the slot is unassigned. */
  skills: (LoreSkillSlot | null)[];
  /** IDs of all internally-held fragments (usable; lost on death). */
  learnedFragmentIds: string[];
  /** Ticks remaining before each slot can be used again. Index matches skills[]. */
  skillCooldowns: number[];
}

export const LoreLoadout = defineComponent({
  name: "loreLoadout" as const,
  wireId: ComponentType.loreLoadout,
  codec: loreLoadoutCodec,
  default: (): LoreLoadoutData => ({
    skills: [null, null, null, null],
    learnedFragmentIds: [],
    skillCooldowns: [0, 0, 0, 0],
  }),
});

// ---- active effects ----

/**
 * One duration buff or periodic effect on an entity.
 *
 * ticksRemaining:
 *   > 0                         — still active; decremented by BuffSystem each tick
 *   CONSUME_ON_USE_SENTINEL     — effect is consumed on use, not on tick
 *                                 (e.g. damage_boost). Never decremented.
 *   0                           — expired; BuffSystem removes it
 */
export const CONSUME_ON_USE_SENTINEL = 999;

export interface ActiveEffect {
  /**
   * Handler id in the effect registries (apply/tick/compose).
   * Unknown ids fail fast at content load; at runtime assume the id is valid.
   */
  effectStat: string;
  /** Scaled magnitude (damage boost fraction, shield HP, speed bonus, base DPS). */
  magnitude: number;
  ticksRemaining: number;
  sourceEntityId: string;
  /**
   * Per-second health delta applied by the health tick handler each tick
   * (negative = damage, positive = heal). Only present on duration "health"
   * effects such as poison DoTs.
   */
  tickDeltaPerSec?: number;
}

/** True when the effect is consumed on use and should not be auto-decremented. */
export function isConsumeOnUse(effect: ActiveEffect): boolean {
  return effect.ticksRemaining === CONSUME_ON_USE_SENTINEL;
}

export interface ActiveEffectsData {
  effects: ActiveEffect[];
}

export const ActiveEffects = defineComponent({
  name: "activeEffects" as const,
  wireId: ComponentType.activeEffects,
  codec: activeEffectsCodec,
  default: (): ActiveEffectsData => ({ effects: [] }),
});
