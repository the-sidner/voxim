import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { ACTION_EQUIP, hasAction } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { Position, InputState } from "../components/game.ts";
import { Inventory, InteractCooldown } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { ItemData } from "../components/items.ts";
import { Equipment } from "../components/equipment.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("EquipmentSystem");
const EQUIP_COOLDOWN_TICKS = 10; // 0.5s at 20Hz

export class EquipmentSystem implements System {
  constructor(private readonly content: ContentStore) {}

  run(world: World, _events: EventEmitter, _dt: number): void {
    for (const { entityId, inputState, interactCooldown } of world.query(InputState, InteractCooldown)) {
      if (interactCooldown.remaining > 0) continue;
      if (!hasAction(inputState.actions, ACTION_EQUIP)) continue;

      const equipment = world.get(entityId, Equipment);
      const inv = world.get(entityId, Inventory);
      if (!equipment || !inv) continue;

      world.set(entityId, InteractCooldown, { remaining: EQUIP_COOLDOWN_TICKS });

      if (equipment.weapon === null) {
        const idx = inv.slots.findIndex((s) =>
          this.content.getItemTemplate(s.itemType)?.category === "weapon"
        );
        if (idx !== -1) {
          const slot = inv.slots[idx];
          world.set(entityId, Equipment, { ...equipment, weapon: slot });
          world.set(entityId, Inventory, { ...inv, slots: inv.slots.filter((_, i) => i !== idx) });
          log.info("equipped weapon: entity=%s item=%s", entityId, slot.itemType);
          continue;
        }
      }

      if (equipment.armor === null) {
        const idx = inv.slots.findIndex((s) =>
          this.content.getItemTemplate(s.itemType)?.category === "armor"
        );
        if (idx !== -1) {
          const slot = inv.slots[idx];
          world.set(entityId, Equipment, { ...equipment, armor: slot });
          world.set(entityId, Inventory, { ...inv, slots: inv.slots.filter((_, i) => i !== idx) });
          log.info("equipped armor: entity=%s item=%s", entityId, slot.itemType);
          continue;
        }
      }

      if (equipment.weapon !== null) {
        const returned = returnToInventory(world, entityId, equipment.weapon, inv);
        world.set(entityId, Equipment, { ...equipment, weapon: null });
        if (returned) {
          world.set(entityId, Inventory, { ...inv, slots: returned });
          log.info("unequipped weapon: entity=%s item=%s (returned to inventory)", entityId, equipment.weapon.itemType);
        } else {
          log.info("unequipped weapon: entity=%s item=%s (dropped — inventory full)", entityId, equipment.weapon.itemType);
        }
        continue;
      }

      if (equipment.armor !== null) {
        const returned = returnToInventory(world, entityId, equipment.armor, inv);
        world.set(entityId, Equipment, { ...equipment, armor: null });
        if (returned) {
          world.set(entityId, Inventory, { ...inv, slots: returned });
          log.info("unequipped armor: entity=%s item=%s (returned to inventory)", entityId, equipment.armor.itemType);
        } else {
          log.info("unequipped armor: entity=%s item=%s (dropped — inventory full)", entityId, equipment.armor.itemType);
        }
      }
    }
  }
}

function returnToInventory(
  world: World,
  entityId: EntityId,
  slot: InventorySlot,
  inv: { slots: InventorySlot[]; capacity: number },
): InventorySlot[] | null {
  const total = inv.slots.reduce((s, sl) => s + sl.quantity, 0);
  if (total + slot.quantity <= inv.capacity) return [...inv.slots, slot];
  dropItem(world, entityId, slot);
  return null;
}

function dropItem(world: World, entityId: EntityId, slot: InventorySlot): void {
  const pos = world.get(entityId, Position);
  if (!pos) return;
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x: pos.x + (Math.random() - 0.5), y: pos.y + (Math.random() - 0.5), z: pos.z });
  world.write(id, ItemData, {
    itemType: slot.itemType,
    quantity: slot.quantity,
    ...(slot.parts ? { parts: slot.parts } : {}),
    ...(slot.condition !== undefined ? { condition: slot.condition } : {}),
  });
}
