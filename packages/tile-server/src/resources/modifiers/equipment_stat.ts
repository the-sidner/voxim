/**
 * equipment_stat rate modifier (T-238b).
 *
 * Sums a `DerivedItemStats` field across the entity's worn armour slots and
 * folds it into the running rate. params:
 *   { stat: string, mode: "subtract_fraction" }
 * `subtract_fraction` → `rate × (1 − clamp01(Σ stat))` — the stamina
 * regen-penalty coupling (a heavier kit regenerates stamina slower).
 */

import type { ResourceRateModifier } from "../modifier.ts";
import { Equipment } from "../../components/equipment.ts";

export const equipmentStatModifier: ResourceRateModifier = {
  id: "equipment_stat",
  rate(ctx, current) {
    const stat = ctx.params.stat as string;
    const eq = ctx.world.get(ctx.entityId, Equipment);
    if (!eq) return current;
    const sum = [eq.head, eq.chest, eq.legs, eq.feet, eq.back].reduce((acc, slot) => {
      if (!slot) return acc;
      const v = ctx.content.deriveItemStats(slot.prefabId) as unknown as Record<string, number | undefined>;
      return acc + (v[stat] ?? 0);
    }, 0);
    if (ctx.params.mode === "subtract_fraction") {
      return current * (1 - Math.min(1, Math.max(0, sum)));
    }
    return current;
  },
};
