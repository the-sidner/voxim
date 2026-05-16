/**
 * `encumbrance` ModifierSource (T-239) — carried weight → a single
 * `moveSpeed` multiplicative factor, computed live. This *is* the retired
 * EncumbranceSystem's math (it had no other output): under the hybrid
 * model the system + its EncumbrancePenalty component dissolve into this
 * one contributor (supersedes the earlier "keep the system" call — see
 * STATUS_MODIFIER_PLAN.md).
 *
 *   ratio = carriedWeight / maxCarryWeight
 *   ≤ penaltyThresholdRatio → 1.0 (no penalty)
 *   ≥ 1.0                   → minSpeedMultiplier
 *   between                 → linear lerp 1.0 → minSpeedMultiplier
 */

import type { EntityId } from "@voxim/engine";
import { Inventory, ItemData } from "../../components/items.ts";
import { Equipment } from "../../components/equipment.ts";
import type { ModifierSource, StatModifier } from "../modifier.ts";

export const encumbranceSource: ModifierSource = {
  id: "encumbrance",
  contribute(ctx): StatModifier[] {
    const inv = ctx.world.get(ctx.entityId, Inventory);
    if (!inv) return [];

    let totalWeight = 0;
    for (const slot of inv.slots) {
      if (slot.kind === "stack") {
        totalWeight +=
          ctx.content.deriveItemStats(slot.prefabId).weight * slot.quantity;
      } else {
        const prefabId = ctx.world.get(slot.entityId as EntityId, ItemData)?.prefabId;
        if (prefabId) totalWeight += ctx.content.deriveItemStats(prefabId).weight;
      }
    }
    const eq = ctx.world.get(ctx.entityId, Equipment);
    if (eq) {
      for (const slot of [eq.weapon, eq.offHand, eq.head, eq.chest, eq.legs, eq.feet, eq.back]) {
        if (slot) totalWeight += ctx.content.deriveItemStats(slot.prefabId).weight;
      }
    }

    const cfg = ctx.content.getGameConfig().encumbrance;
    const ratio = totalWeight / cfg.maxCarryWeight;
    let multiplier: number;
    if (ratio <= cfg.penaltyThresholdRatio) {
      multiplier = 1.0;
    } else if (ratio >= 1.0) {
      multiplier = cfg.minSpeedMultiplier;
    } else {
      const t = (ratio - cfg.penaltyThresholdRatio) / (1.0 - cfg.penaltyThresholdRatio);
      multiplier = 1.0 - t * (1.0 - cfg.minSpeedMultiplier);
    }
    return [{ stat: "moveSpeed", op: "mul", value: multiplier }];
  },
};
