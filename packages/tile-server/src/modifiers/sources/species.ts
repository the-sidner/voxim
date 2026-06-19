/**
 * `species` ModifierSource (T-084) — the actor's species id → its passive-trait
 * `StatModifier`s, read live from `game_config.species`. An actor's species
 * lives on the server-only `Species` component; the trait composes with
 * equipment / encumbrance / buffs through the same `effective()` fold, so a
 * species bonus needs no bespoke stat path. Stats not queried via `effective()`
 * (e.g. maxHealth, set once at spawn) simply won't see the modifier today.
 */
import { Species } from "../../components/species.ts";
import type { ModifierSource, StatModifier } from "../modifier.ts";

export const speciesSource: ModifierSource = {
  id: "species",
  contribute(ctx): StatModifier[] {
    const species = ctx.world.get(ctx.entityId, Species);
    if (!species) return [];
    const def = ctx.content.getGameConfig().species[species.speciesId];
    if (!def) return [];
    return def.modifiers.map((m) => ({ stat: m.stat, op: m.op, value: m.value }));
  },
};
