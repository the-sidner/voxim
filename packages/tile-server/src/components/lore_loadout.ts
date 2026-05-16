import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { loreLoadoutCodec } from "@voxim/codecs";
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

// ActiveEffects retired (T-239): buffs/DoTs/speed are no longer a list on
// the actor. A buff is a scene-graph child (BuffSpec + buff ambient action
// + buff_timer Resource); the `buffs` ModifierSource reads it via
// effective(). Wire id 28 stays reserved (component_types.ts).
