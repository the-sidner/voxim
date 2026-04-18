import type { World } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { ContentStore, PrefabResourceNodeData } from "@voxim/content";
import type { EventEmitter } from "../system.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";
import { ResourceNode } from "../components/resource_node.ts";
import { ItemData } from "../components/items.ts";
import { Position } from "../components/game.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ResourceNodeHitHandler");

/**
 * Handles hits on entities that have a ResourceNode component.
 * Applies harvest damage, spawns yields on depletion, and schedules respawn.
 *
 * Extracted from GatheringSystem — the respawn countdown remains in ResourceNodeSystem.
 */
export class ResourceNodeHitHandler implements HitHandler {
  constructor(private readonly content: ContentStore) {}

  onHit(world: World, events: EventEmitter, ctx: HitContext): void {
    const rn = world.get(ctx.targetId, ResourceNode);
    if (!rn) return;
    if (rn.depleted) return;

    const prefab = this.content.getPrefab(rn.nodeTypeId);
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
    if (rnData) spawnYields(world, rnData.yields, harvestPower, ctx.hitX, ctx.hitY, ctx.hitZ);

    log.info("node depleted: entity=%s type=%s by=%s", ctx.targetId, rn.nodeTypeId, ctx.attackerId);
    events.publish(TileEvents.NodeDepleted, {
      nodeId: ctx.targetId,
      nodeTypeId: rn.nodeTypeId,
      harvesterId: ctx.attackerId,
    });

    if (rnData?.respawnTicks != null) {
      world.set(ctx.targetId, ResourceNode, {
        ...rn,
        hitPoints: 0,
        depleted: true,
        respawnTicksRemaining: rnData.respawnTicks,
      });
    } else {
      world.destroy(ctx.targetId);
    }
  }
}

function spawnYields(
  world: World,
  yields: Array<{ itemType: string; quantity: number; quantityPerHarvestPower?: number }>,
  harvestPower: number,
  hitX: number,
  hitY: number,
  hitZ: number,
): void {
  // Items always drop at the hit contact point — players pick them up via ItemPickupSystem.
  // Each yield unit spawns as a separate world entity with a small random scatter so
  // stacked drops don't all land on the same pixel.
  for (const yld of yields) {
    const qty = yld.quantity + Math.floor((harvestPower - 1) * (yld.quantityPerHarvestPower ?? 0));
    if (qty <= 0) continue;

    const id = newEntityId();
    world.create(id);
    world.write(id, Position, {
      x: hitX + (Math.random() - 0.5) * 0.6,
      y: hitY + (Math.random() - 0.5) * 0.6,
      z: hitZ,
    });
    world.write(id, ItemData, { itemType: yld.itemType, quantity: qty });
    log.info("yield dropped: item=%sx%d at (%.2f,%.2f)", yld.itemType, qty, hitX, hitY);
  }
}
