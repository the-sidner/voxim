/**
 * `equipment` ModifierSource (T-239) — equipped items' derived stats as
 * modifiers, read live from the Equipment component (the single source of
 * truth). Nothing is copied or synced into a ledger.
 *
 * Replaces the duplicated per-consumer `deriveItemStats` scans (armor in
 * the hit handler, the stamina-regen penalty in the resource modifier).
 * Quality is read per slot-entity exactly as the hit handler did.
 *
 *   armorReduction      → add  (slots sum: Σ reduction)
 *   staminaRegenPenalty → mul  (1 − penalty; composes the same way the
 *                               retired `equipment_stat` rate modifier did)
 */

import type { EntityId } from "@voxim/engine";
import { Equipment } from "../../components/equipment.ts";
import { QualityStamped } from "../../components/instance.ts";
import type { ModifierSource, StatModifier } from "../modifier.ts";

const SLOTS = ["weapon", "offHand", "head", "chest", "legs", "feet", "back"] as const;

export const equipmentSource: ModifierSource = {
  id: "equipment",
  contribute(ctx): StatModifier[] {
    const eq = ctx.world.get(ctx.entityId, Equipment);
    if (!eq) return [];
    const out: StatModifier[] = [];
    for (const slotName of SLOTS) {
      const slot = eq[slotName];
      if (!slot) continue;
      const quality =
        ctx.world.get(slot.entityId as EntityId, QualityStamped)?.quality ?? 1;
      const s = ctx.content.deriveItemStats(slot.prefabId, [], quality);
      if (s.armorReduction !== undefined) {
        out.push({ stat: "armorReduction", op: "add", value: s.armorReduction });
      }
      if (s.staminaRegenPenalty !== undefined) {
        out.push({
          stat: "staminaRegen",
          op: "mul",
          value: 1 - Math.min(1, s.staminaRegenPenalty),
        });
      }
    }
    return out;
  },
};
