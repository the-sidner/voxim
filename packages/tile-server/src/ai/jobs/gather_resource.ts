/**
 * GatherResource — walks to the nearest live resource-node entity whose
 * prefab id is in the job's acceptable set, hits it until it depletes, then
 * collects the ItemData drops it ejected and folds them into its own
 * inventory (T-144).
 *
 * One job covers chop + collect because the node and its drops share a spot.
 * Each tick resolves a single target by priority:
 *   1. the bound node, while it's still live → walk up and chop
 *   2. else the nearest settled drop in range → walk over and pick up
 *   3. else the nearest other live node → bind it and chop next
 * So a forester finishes its tree, sweeps the logs it dropped, then moves on.
 *
 * Self-terminates when inventory reaches targetQuantity, when nothing is left
 * to chop or collect, or when the inventory is full while drops remain (the
 * drops stay on the ground, matching the player flow — never silently voided).
 */
import type { GameConfig, ContentService } from "@voxim/content";
import type { World, EntityId } from "@voxim/engine";
import { ACTION_USE_SKILL } from "@voxim/protocol";
import type {
  JobHandler,
  JobContext,
  JobTickAction,
  JobTickInput,
} from "../job_handler.ts";
import type { Job, NpcPlanData } from "../../components/npcs.ts";
import type { InventorySlot } from "@voxim/codecs";
import { Position, Velocity } from "../../components/game.ts";
import { Inventory, ItemData } from "../../components/items.ts";
import { ResourceNode } from "../../components/resource_node.ts";
import { moveSteps } from "../plan_helpers.ts";

const NO_ACTION: JobTickAction = { movementX: 0, movementY: 0, actions: 0 };

const GATHER_EXPIRY_TICKS = 600;

/** How far from the NPC to look for its own drops once the node is depleted. */
const COLLECT_RADIUS = 6;

type GatherJob = Extract<Job, { type: "gatherResource" }>;
type Target =
  | { kind: "chop"; id: EntityId; reach: number }
  | { kind: "collect"; id: EntityId; reach: number };

export const gatherResourceJob: JobHandler = {
  id: "gatherResource",

  expiryTicks(_defaults: GameConfig["npcAiDefaults"]): number {
    return GATHER_EXPIRY_TICKS;
  },

  plan(ctx: JobContext, job: Job): NpcPlanData | null {
    if (job.type !== "gatherResource") return null;

    const target = resolveTarget(ctx.world, ctx.content, job, ctx.pos.x, ctx.pos.y, ctx.tuning);
    if (!target) return null;
    const pos = ctx.world.get(target.id, Position);
    if (!pos) return null;

    const dx0 = ctx.pos.x - pos.x;
    const dy0 = ctx.pos.y - pos.y;
    const d0 = Math.sqrt(dx0 * dx0 + dy0 * dy0) || 1;
    const destX = pos.x + (dx0 / d0) * target.reach;
    const destY = pos.y + (dy0 / d0) * target.reach;

    return {
      steps: moveSteps(ctx.pos.x, ctx.pos.y, destX, destY, ctx.defaults.waypointSpacing),
      stepIdx: 0,
      expiresAt: ctx.currentTick + ctx.defaults.planExpiryTicks,
      lastKnownTargetX: pos.x,
      lastKnownTargetY: pos.y,
    };
  },

  tick(input: JobTickInput): JobTickAction {
    const { ctx, job } = input;
    if (job.type !== "gatherResource") return NO_ACTION;

    if (inventoryHas(ctx.world, ctx.entityId, job.itemType) >= job.targetQuantity) {
      return { ...NO_ACTION, clearJob: true };
    }

    const target = resolveTarget(ctx.world, ctx.content, job, ctx.pos.x, ctx.pos.y, ctx.tuning);
    if (!target) return { ...NO_ACTION, clearJob: true };

    const pos = ctx.world.get(target.id, Position);
    if (!pos) return { ...NO_ACTION, clearJob: true };
    const dx = pos.x - ctx.pos.x;
    const dy = pos.y - ctx.pos.y;
    const distSq = dx * dx + dy * dy;
    const face = Math.atan2(dy, dx);

    if (target.kind === "chop") {
      // Bind the node so the NPC commits to finishing this one before others.
      if (target.id !== job.nodeId) {
        return { ...NO_ACTION, replaceJob: { ...job, nodeId: target.id } };
      }
      if (distSq <= ctx.tuning.attackRangeSq) {
        return { movementX: 0, movementY: 0, actions: ACTION_USE_SKILL, facing: face };
      }
      return { movementX: input.planDirX, movementY: input.planDirY, actions: 0 };
    }

    // collect
    const pickupRadius = ctx.content.getGameConfig().items.pickupRadius;
    if (distSq <= pickupRadius * pickupRadius) {
      if (!collectDrop(ctx.world, ctx.entityId, target.id)) {
        return { ...NO_ACTION, clearJob: true }; // inventory full — leave the rest
      }
      return { movementX: 0, movementY: 0, actions: 0, facing: face };
    }
    return { movementX: input.planDirX, movementY: input.planDirY, actions: 0 };
  },
};

// ---- target resolution ----

/**
 * Pick what the NPC heads for this tick, by priority: the bound node while it's
 * still live, else the nearest settled drop, else the nearest other live node.
 * Shared by `plan` (path target) and `tick` (action), so both always agree.
 */
function resolveTarget(
  world: World,
  content: ContentService,
  job: GatherJob,
  px: number,
  py: number,
  tuning: { attackRangeSq: number },
): Target | null {
  const chopReach = Math.sqrt(tuning.attackRangeSq) * 0.85;
  const nearestNode = (): Target | null => {
    const id = findNearestNodeOfTypes(world, px, py, job.resourceNodeTypes);
    return id === null ? null : { kind: "chop", id, reach: chopReach };
  };
  const nearestDrop = (): Target | null => {
    const id = findNearestDrop(world, px, py, job.itemType, COLLECT_RADIUS * COLLECT_RADIUS);
    return id === null ? null : { kind: "collect", id, reach: content.getGameConfig().items.pickupRadius * 0.7 };
  };

  if (job.nodeId) {
    // Committed to a node: chop it while it's live; once it's depleted, sweep
    // the drops it left before walking off to the next tree.
    if (world.isAlive(job.nodeId) && !isDepleted(world, job.nodeId)) {
      return { kind: "chop", id: job.nodeId, reach: chopReach };
    }
    return nearestDrop() ?? nearestNode();
  }

  // Fresh job: prefer chopping a node; fall back to collecting an existing
  // drop of the target item when no node is available.
  return nearestNode() ?? nearestDrop();
}

// ---- helpers ----

function findNearestNodeOfTypes(
  world: World,
  px: number,
  py: number,
  accepted: ReadonlyArray<string>,
): EntityId | null {
  const acceptedSet = new Set(accepted);
  let bestId: EntityId | null = null;
  let bestDistSq = Infinity;
  for (const { entityId, resource_node } of world.query(ResourceNode)) {
    if (!acceptedSet.has(resource_node.nodeTypeId)) continue;
    if (resource_node.depleted) continue;
    const pos = world.get(entityId, Position);
    if (!pos) continue;
    const dx = pos.x - px;
    const dy = pos.y - py;
    const d = dx * dx + dy * dy;
    if (d < bestDistSq) { bestDistSq = d; bestId = entityId; }
  }
  return bestId;
}

function isDepleted(world: World, nodeId: EntityId): boolean {
  const rn = world.get(nodeId, ResourceNode);
  return !rn || rn.depleted;
}

/** Nearest settled (no Velocity) ground drop of `itemType` within `maxDistSq`. */
function findNearestDrop(
  world: World,
  px: number,
  py: number,
  itemType: string,
  maxDistSq: number,
): EntityId | null {
  let bestId: EntityId | null = null;
  let bestDistSq = maxDistSq;
  for (const { entityId, itemData } of world.query(ItemData)) {
    if (itemData.prefabId !== itemType) continue;
    if (world.has(entityId, Velocity)) continue; // still in flight — wait for it to settle
    const pos = world.get(entityId, Position);
    if (!pos) continue;
    const dx = pos.x - px;
    const dy = pos.y - py;
    const d = dx * dx + dy * dy;
    if (d <= bestDistSq) { bestDistSq = d; bestId = entityId; }
  }
  return bestId;
}

/**
 * Fold a ground stack into the NPC's inventory and destroy the world entity.
 * Returns false (without mutating) when the inventory has no room — mirrors the
 * player PickUp handler. Resource yields are always stackable, so this only
 * handles the stack path (never unique items).
 */
function collectDrop(world: World, npcId: EntityId, dropId: EntityId): boolean {
  const item = world.get(dropId, ItemData);
  const inv = world.get(npcId, Inventory);
  if (!item || !inv) return false;

  const slots: InventorySlot[] = inv.slots.slice();
  const merged = slots.findIndex((s) => s.kind === "stack" && s.prefabId === item.prefabId);
  if (merged !== -1) {
    const existing = slots[merged] as { kind: "stack"; prefabId: string; quantity: number };
    slots[merged] = { kind: "stack", prefabId: item.prefabId, quantity: existing.quantity + item.quantity };
  } else {
    if (slots.length >= inv.capacity) return false;
    slots.push({ kind: "stack", prefabId: item.prefabId, quantity: item.quantity });
  }

  world.set(npcId, Inventory, { ...inv, slots });
  world.destroy(dropId);
  return true;
}

function inventoryHas(world: World, entityId: EntityId, itemType: string): number {
  const inv = world.get(entityId, Inventory);
  if (!inv) return 0;
  let total = 0;
  for (const s of inv.slots) if (s.kind === "stack" && s.prefabId === itemType) total += s.quantity;
  return total;
}
