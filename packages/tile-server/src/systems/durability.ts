/**
 * DurabilitySystem — decrements Durability on equipped weapons each time they
 * are swung.
 *
 * Fires on the first tick of the active swing phase (same gate used by
 * TerrainDigSystem and ActionSystem) so each swing costs exactly one durability
 * point regardless of how many targets it hits.
 *
 * When remaining reaches 0 the item entity is destroyed. The dangling ref in
 * the owner's Equipment.weapon slot is cleared on the next tick by
 * StaleSlotCleanupSystem — equipment/inventory code never sees a dead ref.
 */
import type { World, EntityId } from "@voxim/engine";
import type { System, EventEmitter } from "../system.ts";
import { SkillInProgress } from "../components/combat.ts";
import { Equipment } from "../components/equipment.ts";
import { ItemData } from "../components/items.ts";
import { Durability } from "../components/instance.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("DurabilitySystem");

export class DurabilitySystem implements System {
  readonly dependsOn = ["ActionSystem"];

  run(world: World, _events: EventEmitter, _dt: number): void {
    for (const { entityId, skillInProgress } of world.query(SkillInProgress)) {
      if (skillInProgress.phase !== "active" || skillInProgress.ticksInPhase !== 0) continue;

      const equip = world.get(entityId, Equipment);
      if (!equip?.weapon) continue;

      const weaponId = equip.weapon as EntityId;
      const dur = world.get(weaponId, Durability);
      if (!dur || dur.remaining <= 0) continue;

      const newRemaining = Math.max(0, dur.remaining - 1);
      if (newRemaining > 0) {
        world.set(weaponId, Durability, { ...dur, remaining: newRemaining });
        continue;
      }

      // Broken — destroy the entity. StaleSlotCleanupSystem will null out the
      // equipment slot next tick. Clearing Equipment here too would be racy:
      // ActionSystem runs this same tick and may already have taken its
      // Equipment snapshot, so the deferred write would be invisible to it.
      const prefabId = world.get(weaponId, ItemData)?.prefabId ?? "unknown";
      world.destroy(weaponId);
      log.info("broken: weapon=%s prefab=%s owner=%s", weaponId, prefabId, entityId);
    }
  }
}
