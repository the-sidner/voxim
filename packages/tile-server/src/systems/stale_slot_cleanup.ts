/**
 * StaleSlotCleanupSystem — scrubs dead entity references out of every
 * Inventory and Equipment slot.
 *
 * Unique items in inventories (`{ kind: "unique", entityId }`) and equipped
 * items (`EquipmentData.<slot>` = EntityId) are entity references. Any system
 * that destroys an item entity leaves the owning slot with a dangling ID
 * until someone clears it. This system is that someone.
 *
 * Runs first in the tick order so that downstream systems — and the outgoing
 * delta — never see a ref to an entity that died last tick. The scan is
 * cheap: O(holders × slots), and almost every iteration is the fast-path
 * (slot is alive, continue).
 */
import type { World, EntityId } from "@voxim/engine";
import type { System, EventEmitter } from "../system.ts";
import { Inventory } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { Equipment } from "../components/equipment.ts";
import type { EquipmentData } from "../components/equipment.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("StaleSlotCleanupSystem");

const EQUIP_KEYS: (keyof EquipmentData)[] = [
  "weapon", "offHand", "head", "chest", "legs", "feet", "back",
];

export class StaleSlotCleanupSystem implements System {
  run(world: World, _events: EventEmitter, _dt: number): void {
    // Inventory: drop unique slots whose entity is gone.
    for (const { entityId, inventory } of world.query(Inventory)) {
      let dirty = false;
      const kept: InventorySlot[] = [];
      for (const slot of inventory.slots) {
        if (slot.kind === "unique" && !world.isAlive(slot.entityId as EntityId)) {
          log.debug("scrubbed inventory slot: owner=%s dead=%s", entityId, slot.entityId);
          dirty = true;
          continue;
        }
        kept.push(slot);
      }
      if (dirty) world.set(entityId, Inventory, { ...inventory, slots: kept });
    }

    // Equipment: null out slots whose entity is gone.
    for (const { entityId, equipment } of world.query(Equipment)) {
      let patched: EquipmentData | null = null;
      for (const k of EQUIP_KEYS) {
        const id = equipment[k];
        if (id && !world.isAlive(id as EntityId)) {
          if (!patched) patched = { ...equipment };
          patched[k] = null;
          log.debug("scrubbed equipment slot: owner=%s slot=%s dead=%s", entityId, k, id);
        }
      }
      if (patched) world.set(entityId, Equipment, patched);
    }
  }
}
