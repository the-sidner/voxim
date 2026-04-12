import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { heritageCodec } from "@voxim/codecs";

// ---- Heritage ----
// Tracks a character's place in their dynasty.
// Applied to each new character when they spawn; accumulated across permadeath cycles.

export interface HeritageTrait {
  /** Trait identifier, e.g. "health_bonus", "lore_fragment" */
  type: string;
  /** Magnitude — interpretation depends on type. */
  value: number;
  /** Which ancestor generation contributed this trait (for display). */
  fromGeneration: number;
}

export interface HeritageData {
  dynastyId: string;
  /** How many characters have died in this dynasty (0 = first character). */
  generation: number;
  /** Traits inherited from ancestors. Accumulate across deaths up to a cap. */
  traits: HeritageTrait[];
}

export const Heritage = defineComponent({
  name: "heritage" as const,
  wireId: ComponentType.heritage,
  codec: heritageCodec,
  default: (): HeritageData => ({
    dynastyId: "",
    generation: 0,
    traits: [],
  }),
});

// ---- Derived bonuses ----

/** Sum health bonus across all inherited traits for this character. */
export function heritageHealthBonus(h: HeritageData): number {
  return h.traits
    .filter((t) => t.type === "health_bonus")
    .reduce((sum, t) => sum + t.value, 0);
}
