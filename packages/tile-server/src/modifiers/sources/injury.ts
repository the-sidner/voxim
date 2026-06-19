/**
 * `injury` ModifierSource (T-008) — each entry on an actor's `Injury` component
 * resolves to its `game_config.injuries[typeId]` debuff and contributes it
 * through the Status/Modifier `effective()` fold. Additive penalties scale with
 * `severity` (a worse break hurts more / repeat injuries stack); multiplicative
 * ones apply per the def. Persists until the treatment flow (T-009) clears it.
 */
import { Injury } from "../../components/injury.ts";
import type { ModifierSource, StatModifier } from "../modifier.ts";

export const injurySource: ModifierSource = {
  id: "injury",
  contribute(ctx): StatModifier[] {
    const inj = ctx.world.get(ctx.entityId, Injury);
    if (!inj || inj.injuries.length === 0) return [];
    const defs = ctx.content.getGameConfig().injuries;
    const out: StatModifier[] = [];
    for (const entry of inj.injuries) {
      const def = defs[entry.typeId];
      if (!def) continue;
      const sev = Math.max(1, entry.severity);
      for (const m of def.modifiers) {
        out.push({ stat: m.stat, op: m.op, value: m.op === "add" ? m.value * sev : m.value });
      }
    }
    return out;
  },
};
