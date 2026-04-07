import type { World } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { Inventory } from "../components/items.ts";
import { Equipment } from "../components/equipment.ts";
import { SpeedModifier } from "../components/world.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("EncumbranceSystem");

export class EncumbranceSystem implements System {
  constructor(private readonly content: ContentStore) {}

  run(world: World, _events: EventEmitter, _dt: number): void {
    const cfg = this.content.getGameConfig().encumbrance;

    for (const { entityId, inventory } of world.query(Inventory, SpeedModifier)) {
      let totalWeight = 0;

      for (const slot of inventory.slots) {
        const template = this.content.getItemTemplate(slot.itemType);
        if (template) totalWeight += template.weight * slot.quantity;
      }

      const equipment = world.get(entityId, Equipment);
      if (equipment) {
        for (const slot of [equipment.weapon, equipment.offHand, equipment.head, equipment.chest, equipment.legs, equipment.feet, equipment.back]) {
          if (slot) totalWeight += this.content.deriveItemStats(slot.itemType, slot.parts).weight;
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

      const prev = world.get(entityId, SpeedModifier)?.multiplier ?? 1.0;
      if (Math.abs(prev - multiplier) > 0.01) {
        log.debug("encumbrance: entity=%s weight=%.1f/%.0f mult=%.2f",
          entityId, totalWeight, cfg.maxCarryWeight, multiplier);
      }

      world.set(entityId, SpeedModifier, { multiplier });
    }
  }
}
