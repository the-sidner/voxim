import type { World } from "@voxim/engine";
import type { ContentStore, PrefabResourceNodeData } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { ResourceNode } from "../components/resource_node.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ResourceNodeSystem");

/**
 * Manages resource node respawn timers.
 *
 * Swing detection and harvest logic have moved to ResourceNodeHitHandler,
 * which is called by ActionSystem on each confirmed hit.
 */
export class ResourceNodeSystem implements System {
  constructor(private readonly content: ContentStore) {}

  run(world: World, _events: EventEmitter, _dt: number): void {
    for (const { entityId, resource_node: rn } of world.query(ResourceNode)) {
      if (!rn.depleted) continue;
      if (rn.respawnTicksRemaining === null) continue;

      const remaining = rn.respawnTicksRemaining - 1;
      if (remaining <= 0) {
        const prefab = this.content.getPrefab(rn.nodeTypeId);
        const template = prefab?.components.resourceNode as PrefabResourceNodeData | undefined;
        log.info("node respawned: entity=%s type=%s", entityId, rn.nodeTypeId);
        world.set(entityId, ResourceNode, {
          nodeTypeId: rn.nodeTypeId,
          hitPoints: template?.hitPoints ?? 1,
          depleted: false,
          respawnTicksRemaining: null,
        });
      } else {
        world.set(entityId, ResourceNode, { ...rn, respawnTicksRemaining: remaining });
      }
    }
  }
}
