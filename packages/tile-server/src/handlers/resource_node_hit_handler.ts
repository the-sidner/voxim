import type { World } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { ContentService, PrefabResourceNodeData } from "@voxim/content";
import type { EventEmitter } from "../system.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";
import { ResourceNode } from "../components/resource_node.ts";
import { Resource } from "../components/resource.ts";
import { spawnGroundStack } from "../spawner.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ResourceNodeHitHandler");

/**
 * Handles hits on entities that have a ResourceNode component.
 * Applies harvest damage, spawns yields on depletion, and schedules respawn.
 *
 * Extracted from GatheringSystem — the respawn countdown is the
 * `respawn_timer` Resource (cross@0 → respawn_node, T-242).
 */
export class ResourceNodeHitHandler implements HitHandler {
  constructor(private readonly content: ContentService) {}

  onHit(world: World, events: EventEmitter, ctx: HitContext): void {
    const rn = world.get(ctx.targetId, ResourceNode);
    if (!rn) return;
    if (rn.depleted) return;

    const prefab = this.content.prefabs.get(rn.nodeTypeId);
    // Prefab.components is open-set; resource-node archetype data is cast
    // through its known shape. Full schema-backed lookup arrives with the
    // prefab plan's later phases.
    const rnData = prefab?.components.resourceNode as PrefabResourceNodeData | undefined;
    const harvestPower = ctx.weaponStats.harvestPower ?? 1;

    const toolMatches =
      rnData?.requiredToolType === null ||
      rnData?.requiredToolType === undefined ||
      ctx.weaponStats.toolType === rnData?.requiredToolType;

    const hitDamage = toolMatches ? harvestPower : 1;
    const newHp = rn.hitPoints - hitDamage;

    log.debug(
      "node hit: harvester=%s node=%s type=%s hp=%d→%d power=%d",
      ctx.attackerId,
      ctx.targetId,
      rn.nodeTypeId,
      rn.hitPoints,
      newHp,
      hitDamage,
    );

    if (newHp > 0) {
      world.set(ctx.targetId, ResourceNode, { ...rn, hitPoints: newHp });
      return;
    }

    // ── Node depleted ─────────────────────────────────────────────────────────
    if (rnData) {
      spawnYields(
        world, this.content, rnData.yields, harvestPower,
        ctx.hitX, ctx.hitY, ctx.hitZ,
        ctx.targetX, ctx.targetY,
      );
    }

    log.info("node depleted: entity=%s type=%s by=%s", ctx.targetId, rn.nodeTypeId, ctx.attackerId);
    events.publish(TileEvents.NodeDepleted, {
      nodeId: ctx.targetId,
      nodeTypeId: rn.nodeTypeId,
      harvesterId: ctx.attackerId,
    });

    if (rnData?.respawnTicks != null) {
      // T-242: the respawn countdown is a Resource (cross@0 →
      // respawn_node), not a `respawnTicksRemaining` field + a bespoke
      // system. depleted:true now always coexists with this timer.
      world.set(ctx.targetId, ResourceNode, { ...rn, hitPoints: 0, depleted: true });
      const res = world.get(ctx.targetId, Resource);
      world.set(ctx.targetId, Resource, {
        values: {
          ...(res?.values ?? {}),
          respawn_timer: { value: rnData.respawnTicks, max: rnData.respawnTicks },
        },
      });
    } else {
      world.destroy(ctx.targetId);
    }
  }
}

function spawnYields(
  world: World,
  content: ContentService,
  yields: Array<{ itemType: string; quantity: number; quantityPerHarvestPower?: number }>,
  harvestPower: number,
  hitX: number,
  hitY: number,
  hitZ: number,
  sourceX: number,
  sourceY: number,
): void {
  // Drops spawn at the hit point and are ejected away from the source
  // centre by ItemPhysicsSystem — they fly out, arc, and land on a free
  // cell next to the depleted node.  spreadRad fans multiple yield types
  // so they don't all land in the same direction.
  for (const yld of yields) {
    const qty = yld.quantity + Math.floor((harvestPower - 1) * (yld.quantityPerHarvestPower ?? 0));
    if (qty <= 0) continue;

    spawnGroundStack(
      world, content, yld.itemType, qty,
      { x: hitX, y: hitY, z: hitZ },
      { from: { x: sourceX, y: sourceY }, spreadRad: Math.PI / 3 },
    );
    log.info("yield dropped: item=%sx%d ejected from (%.2f,%.2f)", yld.itemType, qty, sourceX, sourceY);
  }
}
