import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { loreLoadoutCodec } from "@voxim/codecs";

/**
 * The four equippable skill slots (T-260b): each names a skill `ActionDef`
 * id — the dispatcher starts it like any other action (costs, per-action
 * cooldown, GCD, gates all live on the def / in ActionCooldowns). The old
 * verb+fragment pair and the wire-side cooldown arrays are gone with the
 * concept-verb matrix.
 */
export interface LoreLoadoutData {
  /** Skill ActionDef ids; null = unassigned slot. */
  skills: (string | null)[];
  /** IDs of all internally-held fragments (usable; lost on death). */
  learnedFragmentIds: string[];
}

export const LoreLoadout = defineComponent({
  name: "loreLoadout" as const,
  wireId: ComponentType.loreLoadout,
  codec: loreLoadoutCodec,
  default: (): LoreLoadoutData => ({
    skills: [null, null, null, null],
    learnedFragmentIds: [],
  }),
});

// ActiveEffects retired (T-239): buffs/DoTs/speed are no longer a list on
// the actor. A buff is a scene-graph child (BuffSpec + buff ambient action
// + buff_timer Resource); the `buffs` ModifierSource reads it via
// effective(). Wire id 28 stays reserved (component_types.ts).
