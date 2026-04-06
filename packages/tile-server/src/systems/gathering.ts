import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { ACTION_USE_SKILL, hasAction, TileEvents } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import type { SpatialGrid } from "../spatial_grid.ts";
import { Position, InputState, SkillInProgress } from "../components/game.ts";
import { Equipment } from "../components/equipment.ts";
import { Inventory } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { ItemData } from "../components/items.ts";
import { ResourceNode } from "../components/resource_node.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("GatheringSystem");

export class GatheringSystem implements System {
  private spatial: SpatialGrid | null = null;

  constructor(private readonly content: ContentStore) {}

  prepare(_serverTick: number, ctx: TickContext): void {
    this.spatial = ctx.spatial;
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    // ── Step 1: advance respawn timers ──────────────────────────────────────
    for (const { entityId, resource_node: rn } of world.query(ResourceNode)) {
      if (!rn.depleted) continue;
      if (rn.respawnTicksRemaining === null) continue;

      const remaining = rn.respawnTicksRemaining - 1;
      if (remaining <= 0) {
        const template = this.content.getNodeTemplate(rn.nodeTypeId);
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

    // ── Step 2: resolve harvesting swings ───────────────────────────────────
    for (const { entityId, inputState, position } of world.query(InputState, Position)) {
      if (!hasAction(inputState.actions, ACTION_USE_SKILL)) continue;
      const sip = world.get(entityId, SkillInProgress);
      if (sip) continue; // swing already in progress

      const equipment = world.get(entityId, Equipment);
      const weapon = equipment?.weapon ?? null;
      const toolStats = weapon ? this.content.deriveItemStats(weapon.itemType, weapon.parts) : null;

      if (!toolStats?.toolType) continue;

      const harvestPower = toolStats.harvestPower ?? 1;
      const range = toolStats.attackRange ?? 1.5;
      const arcHalf = toolStats.attackArcHalf ?? Math.PI / 3;

      const candidates = this.spatial
        ? this.spatial.nearby(position.x, position.y, range)
        : world.query(ResourceNode, Position).map((r) => r.entityId);

      for (const nodeId of candidates) {
        const rn = world.get(nodeId, ResourceNode);
        if (!rn || rn.depleted) continue;
        const nodePos = world.get(nodeId, Position);
        if (!nodePos) continue;

        const dx = nodePos.x - position.x;
        const dy = nodePos.y - position.y;
        if (dx * dx + dy * dy > range * range) continue;

        const angleToNode = Math.atan2(dy, dx);
        if (angleDiff(angleToNode, inputState.facing) > arcHalf) continue;

        const template = this.content.getNodeTemplate(rn.nodeTypeId);
        const hitDamage = toolStats.toolType === template?.requiredToolType ? harvestPower : 1;
        const newHp = rn.hitPoints - hitDamage;

        log.debug("node hit: harvester=%s node=%s type=%s hp=%d→%d power=%d",
          entityId, nodeId, rn.nodeTypeId, rn.hitPoints, newHp, hitDamage);

        if (newHp <= 0) {
          if (template) spawnYields(world, nodeId, entityId, template.yields, harvestPower);

          log.info("node depleted: entity=%s type=%s by=%s", nodeId, rn.nodeTypeId, entityId);
          events.publish(TileEvents.NodeDepleted, { nodeId, nodeTypeId: rn.nodeTypeId, harvesterId: entityId });

          if (template?.respawnTicks != null) {
            world.set(nodeId, ResourceNode, { ...rn, hitPoints: 0, depleted: true, respawnTicksRemaining: template.respawnTicks });
          } else {
            world.destroy(nodeId);
          }
        } else {
          world.set(nodeId, ResourceNode, { ...rn, hitPoints: newHp });
        }
      }

    }
  }
}

function angleDiff(a: number, b: number): number {
  const raw = ((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  return Math.abs(raw);
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
      world.write(id, Position, { x: pos.x + (Math.random() - 0.5), y: pos.y + (Math.random() - 0.5), z: pos.z });
      world.write(id, ItemData, { itemType: yld.itemType, quantity: qty });
      log.info("yield dropped: item=%sx%d at (%.1f,%.1f) — inventory full", yld.itemType, qty, pos.x, pos.y);
    }
  }
}

function addStackableItem(slots: InventorySlot[], itemType: string, quantity: number, capacity: number): InventorySlot[] | null {
  const total = slots.reduce((s, sl) => s + sl.quantity, 0);
  if (total + quantity > capacity) return null;
  const existing = slots.find((s) => s.itemType === itemType && !s.parts);
  if (existing) return slots.map((s) => s === existing ? { ...s, quantity: s.quantity + quantity } : s);
  return [...slots, { itemType, quantity }];
}
