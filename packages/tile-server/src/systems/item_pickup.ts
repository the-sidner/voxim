/**
 * ItemPickupSystem — auto-collects nearby ItemData entities into Inventory.
 *
 * Each tick: for every entity with an Inventory, scan ItemData entities within
 * pickupRadius (from game_config.items.pickupRadius). Collect as many as fit,
 * stacking stackable types. World entity is destroyed on collection.
 *
 * This applies to players and NPCs equally — the same component query hits both.
 * NPCs use the same path (seekFood/seekWater jobs steer toward items; once within
 * radius this system collects them automatically).
 */
import type { World, EntityId } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { Position } from "../components/game.ts";
import { Inventory, ItemData } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ItemPickupSystem");

export class ItemPickupSystem implements System {
  constructor(private readonly content: ContentStore) {}

  run(world: World, _events: EventEmitter, _dt: number): void {
    const radiusSq = this.content.getGameConfig().items.pickupRadius ** 2;

    // Build a snapshot of all item drops this tick (position + data)
    const drops: Array<{ entityId: EntityId; x: number; y: number; z: number; itemType: string; quantity: number }> = [];
    for (const { entityId, position, itemData } of world.query(Position, ItemData)) {
      drops.push({ entityId, x: position.x, y: position.y, z: position.z, itemType: itemData.itemType, quantity: itemData.quantity });
    }
    if (drops.length === 0) return;

    // Track which drops have already been claimed this tick (prevent double-pickup)
    const claimed = new Set<EntityId>();

    for (const { entityId: collectorId, position, inventory } of world.query(Position, Inventory)) {
      let slots = inventory.slots;
      let changed = false;

      for (const drop of drops) {
        if (claimed.has(drop.entityId)) continue;

        const dx = drop.x - position.x;
        const dy = drop.y - position.y;
        if (dx * dx + dy * dy > radiusSq) continue;

        const newSlots = addToInventory(slots, drop.itemType, drop.quantity, inventory.capacity);
        if (newSlots === null) continue; // no room

        slots = newSlots;
        changed = true;
        claimed.add(drop.entityId);
        log.info("pickup: collector=%s item=%sx%d", collectorId, drop.itemType, drop.quantity);
      }

      if (changed) {
        world.set(collectorId, Inventory, { ...inventory, slots });
      }
    }

    for (const id of claimed) {
      world.destroy(id);
    }
  }
}

function addToInventory(
  slots: InventorySlot[],
  itemType: string,
  quantity: number,
  capacity: number,
): InventorySlot[] | null {
  const total = slots.reduce((s, sl) => s + sl.quantity, 0);
  if (total + quantity > capacity) return null;
  const existing = slots.find((s) => s.itemType === itemType && !s.parts);
  if (existing) {
    return slots.map((s) => s === existing ? { ...s, quantity: s.quantity + quantity } : s);
  }
  return [...slots, { itemType, quantity }];
}
