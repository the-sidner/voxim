import type { World, EntityId } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { Inventory, ItemData } from "../components/items.ts";
import { Equipment } from "../components/equipment.ts";
import { EncumbrancePenalty } from "../components/world.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("EncumbranceSystem");

/**
 * Derives an encumbrance penalty multiplier from carried weight and writes it
 * to EncumbrancePenalty. BuffSystem then composes this with all speed ActiveEffects
 * to produce the final SpeedModifier that PhysicsSystem reads.
 *
 * EncumbranceSystem never touches SpeedModifier directly — it only sets the base.
 */
export class EncumbranceSystem implements System {
  constructor(private readonly content: ContentStore) {}

  run(world: World, _events: EventEmitter, _dt: number): void {
    const cfg = this.content.getGameConfig().encumbrance;

    for (const { entityId, inventory } of world.query(Inventory, EncumbrancePenalty)) {
      let totalWeight = 0;

      for (const slot of inventory.slots) {
        if (slot.kind === "stack") {
          totalWeight += this.content.deriveItemStats(slot.prefabId).weight * slot.quantity;
        } else {
          const prefabId = world.get(slot.entityId as EntityId, ItemData)?.prefabId;
          if (prefabId) totalWeight += this.content.deriveItemStats(prefabId).weight;
        }
      }

      const equipment = world.get(entityId, Equipment);
      if (equipment) {
        for (const slotId of [equipment.weapon, equipment.offHand, equipment.head, equipment.chest, equipment.legs, equipment.feet, equipment.back]) {
          if (!slotId) continue;
          const prefabId = world.get(slotId as EntityId, ItemData)?.prefabId;
          if (prefabId) totalWeight += this.content.deriveItemStats(prefabId).weight;
        }
      }

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

      const prev = world.get(entityId, EncumbrancePenalty)?.multiplier ?? 1.0;
      if (Math.abs(prev - multiplier) > 0.01) {
        log.debug("encumbrance: entity=%s weight=%.1f/%.0f mult=%.2f",
          entityId, totalWeight, cfg.maxCarryWeight, multiplier);
      }

      world.set(entityId, EncumbrancePenalty, { multiplier });
    }
  }
}
