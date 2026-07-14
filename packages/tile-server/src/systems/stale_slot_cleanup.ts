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
import { Equipment } from "../components/equipment.ts";
import type { EquipmentData } from "../components/equipment.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("StaleSlotCleanupSystem");

const EQUIP_KEYS: (keyof EquipmentData)[] = [
  "weapon", "offHand", "head", "chest", "legs", "feet", "back",
];

export class StaleSlotCleanupSystem implements System {
  run(world: World, _events: EventEmitter, _dt: number): void {
    // Inventory: drop unique slots whose entity is gone. T-344: this system
    // is itself a writer of both Inventory and Equipment, and every other
    // writer of those components was migrated to world.mutate for exactly
    // this reason — a plain world.set here would silently clobber whatever
    // another system (or another entity's cross-referencing op) wrote to
    // the SAME component this SAME tick. world.isAlive is impure and can't
    // run inside a mutate closure, so the dead-entity check happens here,
    // in the imperative scan (fine — this isn't inside a closure), and only
    // the resulting plain Set of dead ids crosses into the closure.
    for (const { entityId, inventory } of world.query(Inventory)) {
      const dead = new Set<EntityId>();
      for (const slot of inventory.slots) {
        if (slot.kind === "unique" && !world.isAlive(slot.entityId as EntityId)) {
          dead.add(slot.entityId as EntityId);
        }
      }
      if (dead.size === 0) continue;
      world.mutate(entityId, Inventory, (cur) => {
        const kept = cur.slots.filter((s) => !(s.kind === "unique" && dead.has(s.entityId as EntityId)));
        if (kept.length === cur.slots.length) return cur; // already scrubbed by an earlier same-tick op
        for (const slot of cur.slots) {
          if (slot.kind === "unique" && dead.has(slot.entityId as EntityId)) {
            log.debug("scrubbed inventory slot: owner=%s dead=%s", entityId, slot.entityId);
          }
        }
        return { ...cur, slots: kept };
      });
    }

    // Equipment: null out slots whose entity is gone. Same reasoning as above.
    for (const { entityId, equipment } of world.query(Equipment)) {
      const deadKeys: (keyof EquipmentData)[] = [];
      for (const k of EQUIP_KEYS) {
        const slot = equipment[k];
        if (slot && !world.isAlive(slot.entityId as EntityId)) deadKeys.push(k);
      }
      if (deadKeys.length === 0) continue;
      world.mutate(entityId, Equipment, (cur) => {
        let patched: EquipmentData | null = null;
        for (const k of deadKeys) {
          const slot = cur[k];
          if (!slot) continue; // already cleared by an earlier same-tick op
          if (!patched) patched = { ...cur };
          patched[k] = null;
          log.debug("scrubbed equipment slot: owner=%s slot=%s dead=%s", entityId, k, slot.entityId);
        }
        return patched ?? cur;
      });
    }
  }
}
