import type { World } from "@voxim/engine";
import { ACTION_CONSUME, hasAction } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { InputState, Hunger, Thirst } from "../components/game.ts";
import { Inventory, InteractCooldown } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ConsumptionSystem");
const CONSUME_COOLDOWN_TICKS = 20;

export class ConsumptionSystem implements System {
  constructor(private readonly content: ContentStore) {}

  run(world: World, _events: EventEmitter, _dt: number): void {
    for (const { entityId, inputState, interactCooldown, inventory } of world.query(
      InputState, InteractCooldown, Inventory,
    )) {
      if (interactCooldown.remaining > 0) continue;
      if (!hasAction(inputState.actions, ACTION_CONSUME)) continue;

      const idx = inventory.slots.findIndex(
        (s) => this.content.getItemTemplate(s.itemType)?.category === "consumable",
      );
      if (idx === -1) {
        log.debug("consume: entity=%s no consumable in inventory", entityId);
        continue;
      }

      const slot = inventory.slots[idx];
      const stats = this.content.deriveItemStats(slot.itemType, slot.parts);

      world.set(entityId, InteractCooldown, { remaining: CONSUME_COOLDOWN_TICKS });

      let hungerBefore = 0, thirstBefore = 0;

      if ((stats.foodValue ?? 0) > 0) {
        const hunger = world.get(entityId, Hunger);
        if (hunger) {
          hungerBefore = hunger.value;
          world.set(entityId, Hunger, { value: Math.max(0, hunger.value - stats.foodValue!) });
        }
      }
      if ((stats.waterValue ?? 0) > 0) {
        const thirst = world.get(entityId, Thirst);
        if (thirst) {
          thirstBefore = thirst.value;
          world.set(entityId, Thirst, { value: Math.max(0, thirst.value - stats.waterValue!) });
        }
      }

      const newSlots = consumeOne(inventory.slots, idx);
      world.set(entityId, Inventory, { ...inventory, slots: newSlots });

      log.info("consumed: entity=%s item=%s food=%.1f→%.1f water=%.1f→%.1f",
        entityId, slot.itemType,
        hungerBefore, Math.max(0, hungerBefore - (stats.foodValue ?? 0)),
        thirstBefore, Math.max(0, thirstBefore - (stats.waterValue ?? 0)));
    }
  }
}

function consumeOne(slots: InventorySlot[], idx: number): InventorySlot[] {
  const slot = slots[idx];
  if (slot.quantity <= 1) return slots.filter((_, i) => i !== idx);
  return slots.map((s, i) => i === idx ? { ...s, quantity: s.quantity - 1 } : s);
}
