/**
 * Species (T-084) — the playable species an actor belongs to.
 *
 * Server-only: it carries no presentation, only an id whose passive trait is
 * applied through the Status/Modifier primitive. The `species` ModifierSource
 * reads this component and contributes the species' `StatModifier`s, so the
 * trait composes with equipment / encumbrance / buffs through one `effective()`
 * query — no bespoke stat path. Set at spawn from `game_config.player.species`
 * (real per-character selection lands with character creation, T-071).
 */
import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface SpeciesData {
  speciesId: string;
}

const speciesCodec: Serialiser<SpeciesData> = {
  encode(v) {
    const w = new WireWriter();
    w.writeStr(v.speciesId);
    return w.toBytes();
  },
  decode(b) {
    const r = new WireReader(b);
    return { speciesId: r.readStr() };
  },
};

export const Species = defineComponent({
  name: "species" as const,
  networked: false,
  codec: speciesCodec,
  default: (): SpeciesData => ({ speciesId: "human" }),
});
