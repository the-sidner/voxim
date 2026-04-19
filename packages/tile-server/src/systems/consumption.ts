import type { World, EntityId } from "@voxim/engine";
import { ACTION_CONSUME, hasAction } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { InputState, Hunger, Thirst } from "../components/game.ts";
import { Inventory, InteractCooldown, ItemData } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ConsumptionSystem");

export class ConsumptionSystem implements System {
  constructor(private readonly content: ContentStore) {}

  run(world: World, _events: EventEmitter, _dt: number): void {
    for (const { entityId, inputState, interactCooldown, inventory } of world.query(
      InputState, InteractCooldown, Inventory,
    )) {
      if (interactCooldown.remaining > 0) continue;
      if (!hasAction(inputState.actions, ACTION_CONSUME)) continue;

      const idx = inventory.slots.findIndex((s) => {
        const prefabId = slotPrefabId(s, world);
        return !!prefabId && !!this.content.getPrefab(prefabId)?.components["edible"];
      });
      if (idx === -1) {
        log.debug("consume: entity=%s no consumable in inventory", entityId);
        continue;
      }

      const slot = inventory.slots[idx];
      const prefabId = slotPrefabId(slot, world)!;
      const stats = this.content.deriveItemStats(prefabId);

      world.set(entityId, InteractCooldown, {
        remaining: this.content.getGameConfig().consumption.cooldownTicks,
      });

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

      const newSlots = consumeOne(world, inventory.slots, idx);
      world.set(entityId, Inventory, { ...inventory, slots: newSlots });

      log.info("consumed: entity=%s item=%s food=%.1f→%.1f water=%.1f→%.1f",
        entityId, prefabId,
        hungerBefore, Math.max(0, hungerBefore - (stats.foodValue ?? 0)),
        thirstBefore, Math.max(0, thirstBefore - (stats.waterValue ?? 0)));
    }
  }
}

function slotPrefabId(slot: InventorySlot, world: World): string | null {
  if (slot.kind === "stack") return slot.prefabId;
  return world.get(slot.entityId as EntityId, ItemData)?.prefabId ?? null;
}

function consumeOne(world: World, slots: InventorySlot[], idx: number): InventorySlot[] {
  const slot = slots[idx];
  if (slot.kind === "stack") {
    if (slot.quantity <= 1) return slots.filter((_, i) => i !== idx);
    return slots.map((s, i) => i === idx
      ? { kind: "stack" as const, prefabId: slot.prefabId, quantity: slot.quantity - 1 }
      : s);
  }
  world.destroy(slot.entityId as EntityId);
  return slots.filter((_, i) => i !== idx);
}
