/**
 * GatherResource — walks to the nearest live resource-node entity whose
 * prefab id is in the job's acceptable set, then hits it until the NPC's
 * inventory has the target quantity of the desired item.
 *
 * Yields drop as ItemData entities near the node when it depletes; the
 * NPC's own ItemPickupSystem collects them automatically. That symmetry
 * with the player flow is why we don't need a separate "pick up the drop"
 * state here — the pickup radius handles it.
 *
 * Self-terminates in three cases:
 *   - inventory already has ≥ targetQuantity of itemType → clearJob
 *   - no candidate node exists anywhere on the tile → clearJob
 *   - the resolved node entity dies without satisfying the goal →
 *     re-resolves on the next plan call; plan-builder returning null
 *     cascades into clearJob via the usual path.
 */
import type { GameConfig } from "@voxim/content";
import type { World, EntityId } from "@voxim/engine";
import { ACTION_USE_SKILL } from "@voxim/protocol";
import type {
  JobHandler,
  JobContext,
  JobTickAction,
  JobTickInput,
} from "../job_handler.ts";
import type { Job, NpcPlanData } from "../../components/npcs.ts";
import { Position } from "../../components/game.ts";
import { Inventory } from "../../components/items.ts";
import { ResourceNode } from "../../components/resource_node.ts";
import { moveSteps } from "../plan_helpers.ts";

const NO_ACTION: JobTickAction = { movementX: 0, movementY: 0, actions: 0 };

const GATHER_EXPIRY_TICKS = 600;

export const gatherResourceJob: JobHandler = {
  id: "gatherResource",

  expiryTicks(_defaults: GameConfig["npcAiDefaults"]): number {
    return GATHER_EXPIRY_TICKS;
  },

  plan(ctx: JobContext, job: Job): NpcPlanData | null {
    if (job.type !== "gatherResource") return null;

    const nodeId = job.nodeId ?? findNearestNodeOfTypes(ctx.world, ctx.pos.x, ctx.pos.y, job.resourceNodeTypes);
    if (!nodeId) return null;
    const pos = ctx.world.get(nodeId, Position);
    if (!pos) return null;

    const reach = Math.sqrt(ctx.tuning.attackRangeSq) * 0.85;
    const dx0 = ctx.pos.x - pos.x;
    const dy0 = ctx.pos.y - pos.y;
    const d0 = Math.sqrt(dx0 * dx0 + dy0 * dy0) || 1;
    const destX = pos.x + (dx0 / d0) * reach;
    const destY = pos.y + (dy0 / d0) * reach;

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

    // Done?
    if (inventoryHas(ctx.world, ctx.entityId, job.itemType) >= job.targetQuantity) {
      return { ...NO_ACTION, clearJob: true };
    }

    // Resolve or re-resolve a node each time — handles depletion mid-job.
    let nodeId = job.nodeId;
    if (!nodeId || !ctx.world.isAlive(nodeId) || isDepleted(ctx.world, nodeId)) {
      const fresh = findNearestNodeOfTypes(ctx.world, ctx.pos.x, ctx.pos.y, job.resourceNodeTypes);
      if (!fresh) return { ...NO_ACTION, clearJob: true };
      if (fresh !== nodeId) {
        return { ...NO_ACTION, replaceJob: { ...job, nodeId: fresh } };
      }
      nodeId = fresh;
    }

    const pos = ctx.world.get(nodeId, Position);
    if (!pos) return { ...NO_ACTION, clearJob: true };

    const dx = pos.x - ctx.pos.x;
    const dy = pos.y - ctx.pos.y;
    const distSq = dx * dx + dy * dy;
    const inRange = distSq <= ctx.tuning.attackRangeSq;
    const face = Math.atan2(dy, dx);

    if (inRange) {
      return { movementX: 0, movementY: 0, actions: ACTION_USE_SKILL, facing: face };
    }
    return { movementX: input.planDirX, movementY: input.planDirY, actions: 0 };
  },
};

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

function inventoryHas(world: World, entityId: EntityId, itemType: string): number {
  const inv = world.get(entityId, Inventory);
  if (!inv) return 0;
  let total = 0;
  for (const s of inv.slots) if (s.kind === "stack" && s.prefabId === itemType) total += s.quantity;
  return total;
}
