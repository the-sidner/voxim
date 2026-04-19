/**
 * DurabilitySystem — decrements Durability on equipped weapons each time they
 * are swung (T-117 Phase 4).
 *
 * Fires on the first tick of the active swing phase (same gate used by
 * TerrainDigSystem and ActionSystem) so each swing costs exactly one durability
 * point regardless of how many targets it hits.
 *
 * When remaining reaches 0 the item is "worn out" — further stat consequences
 * (refusing to swing, stat penalties) are wired in Phase 5 via ActionSystem.
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
      world.set(weaponId, Durability, { ...dur, remaining: newRemaining });

      if (newRemaining === 0) {
        const prefabId = world.get(weaponId, ItemData)?.prefabId ?? "unknown";
        log.info("worn out: weapon=%s prefab=%s owner=%s", weaponId, prefabId, entityId);
      }
    }
  }
}
