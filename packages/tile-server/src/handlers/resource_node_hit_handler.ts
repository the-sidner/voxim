import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { EventEmitter } from "../system.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";
import { ResourceNode } from "../components/resource_node.ts";
import { Inventory } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
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

    const entityTemplate = this.content.getEntityTemplate(rn.nodeTypeId);
    const rnData = entityTemplate?.components.resourceNode;
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
    if (rnData) spawnYields(world, ctx.targetId, ctx.attackerId, rnData.yields, harvestPower);

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
  nodeId: EntityId,
  harvesterId: EntityId,
  yields: Array<{ itemType: string; quantity: number; quantityPerHarvestPower?: number }>,
  harvestPower: number,
): void {
  const pos = world.get(nodeId, Position);
  if (!pos) return;

  const inv = world.get(harvesterId, Inventory);

  for (const yld of yields) {
    const qty = yld.quantity + Math.floor((harvestPower - 1) * (yld.quantityPerHarvestPower ?? 0));
    if (qty <= 0) continue;

    let deposited = false;
    if (inv) {
      const newSlots = addStackableItem(inv.slots, yld.itemType, qty, inv.capacity);
      if (newSlots !== null) {
        world.set(harvesterId, Inventory, { ...inv, slots: newSlots });
        inv.slots = newSlots;
        deposited = true;
        log.info("yield collected: harvester=%s item=%sx%d", harvesterId, yld.itemType, qty);
      }
    }

    if (!deposited) {
      const id = newEntityId();
      world.create(id);
      world.write(id, Position, {
        x: pos.x + (Math.random() - 0.5),
        y: pos.y + (Math.random() - 0.5),
        z: pos.z,
      });
      world.write(id, ItemData, { itemType: yld.itemType, quantity: qty });
      log.info(
        "yield dropped: item=%sx%d at (%.1f,%.1f) — inventory full",
        yld.itemType,
        qty,
        pos.x,
        pos.y,
      );
    }
  }
}

function addStackableItem(
  slots: InventorySlot[],
  itemType: string,
  quantity: number,
  capacity: number,
): InventorySlot[] | null {
  const total = slots.reduce((s, sl) => s + sl.quantity, 0);
  if (total + quantity > capacity) return null;
  const existing = slots.find((s) => s.itemType === itemType && !s.parts);
  if (existing) {
    return slots.map((s) => (s === existing ? { ...s, quantity: s.quantity + quantity } : s));
  }
  return [...slots, { itemType, quantity }];
}
