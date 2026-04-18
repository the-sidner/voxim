/**
 * tryProduce — BT node that drives an NPC toward "have N of itemType in
 * inventory" by running the planner each invocation and emitting the sub-job
 * matching the first not-yet-done step.
 *
 * The plan is NOT persisted on the NpcJobQueue. It's regenerated every time
 * the BT fires, which is whenever the selector above reaches this branch:
 * typically "queue empty" or "current sub-job just cleared". Because every
 * step's progress is observable from the entity's components (inventory
 * count, buffer state, node depletion), the planner converges on whatever
 * step is still unfinished — no discrete step-pointer to maintain.
 *
 * Returns:
 *   success when the goal is already met (inventory satisfies target), or
 *           when a sub-job was emitted to make progress.
 *   failure when the planner cannot find any path (no gatherers in range,
 *           required workstations not placed, etc.) — selectors above fall
 *           through to the next branch.
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";
import type { World, EntityId } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import { Inventory } from "../../../components/items.ts";
import { ResourceNode } from "../../../components/resource_node.ts";
import { WorkstationTag } from "../../../components/building.ts";
import { Position } from "../../../components/game.ts";
import { plan as runPlanner } from "../../crafting_planner.ts";
import type { WorldView, CraftingPlanStep } from "../../crafting_planner.ts";

interface TryProduceSpec {
  type: "try_produce";
  targetItem: string;
  quantity?: number;
  /** Range in world units used to test "nearby resource node of this type". */
  gatherScanRadius?: number;
}

const DEFAULT_QUANTITY = 1;
const DEFAULT_SCAN_RADIUS = 64;

export const tryProduceFactory: BTNodeFactory = {
  id: "try_produce",
  build(spec: unknown): BTNode {
    const s = spec as TryProduceSpec;
    if (typeof s.targetItem !== "string" || s.targetItem === "") {
      throw new Error(`try_produce: "targetItem" must be a non-empty string`);
    }
    const targetItem = s.targetItem;
    const quantity   = s.quantity         ?? DEFAULT_QUANTITY;
    const scanRadius = s.gatherScanRadius ?? DEFAULT_SCAN_RADIUS;

    return {
      tick(ctx: BTContext, out: BTOutput): NodeResult {
        // Goal already met.
        if (inventoryCount(ctx.world, ctx.entityId, targetItem) >= quantity) {
          return "failure"; // defers to the next selector branch (idle etc.)
        }

        const view = buildWorldView(ctx.world, ctx.content, ctx.pos.x, ctx.pos.y, scanRadius);
        const graph = ctx.content.getRecipeGraph();
        const plan = runPlanner(targetItem, quantity, inventorySnapshot(ctx.world, ctx.entityId), view, graph);
        if (!plan || plan.steps.length === 0) return "failure";

        // Find the first step that isn't already satisfied.
        const step = firstPendingStep(plan.steps, ctx.world, ctx.entityId);
        if (!step) return "failure";

        // If we're already running a compatible sub-job for this step, stay put.
        const current = ctx.queue.current;
        if (currentJobMatchesStep(current, step)) return "success";

        out.replaceCurrent = stepToJob(step, ctx.currentTick);
        return "success";
      },
    };
  },
};

// ---- helpers ----

function inventoryCount(world: World, entityId: EntityId, itemType: string): number {
  const inv = world.get(entityId, Inventory);
  if (!inv) return 0;
  let total = 0;
  for (const s of inv.slots) if (s.itemType === itemType) total += s.quantity;
  return total;
}

function inventorySnapshot(world: World, entityId: EntityId): import("@voxim/codecs").InventoryData {
  return world.get(entityId, Inventory) ?? { slots: [], capacity: 0 };
}

function buildWorldView(
  world: World,
  content: ContentStore,
  px: number,
  py: number,
  scanRadius: number,
): WorldView {
  const placedWorkbenches = new Map<string, EntityId[]>();
  for (const { entityId, workstationTag } of world.query(WorkstationTag)) {
    const list = placedWorkbenches.get(workstationTag.stationType);
    if (list) list.push(entityId);
    else placedWorkbenches.set(workstationTag.stationType, [entityId]);
  }

  const gatherersByItem = content.getRecipeGraph().gatherers;

  const scanRadiusSq = scanRadius * scanRadius;
  const nearbyResourceNodes = (itemType: string): boolean => {
    const acceptedPrefabs = gatherersByItem.get(itemType);
    if (!acceptedPrefabs || acceptedPrefabs.length === 0) return false;
    const accepted = new Set(acceptedPrefabs);
    for (const { entityId, resource_node } of world.query(ResourceNode)) {
      if (resource_node.depleted) continue;
      if (!accepted.has(resource_node.nodeTypeId)) continue;
      const pos = world.get(entityId, Position);
      if (!pos) continue;
      const dx = pos.x - px;
      const dy = pos.y - py;
      if (dx * dx + dy * dy <= scanRadiusSq) return true;
    }
    return false;
  };

  return { placedWorkbenches, gatherersByItem, nearbyResourceNodes };
}

function firstPendingStep(
  steps: readonly CraftingPlanStep[],
  world: World,
  entityId: EntityId,
): CraftingPlanStep | null {
  for (const step of steps) {
    if (step.kind === "fetch") {
      // fetch is satisfied when inventory already has enough — skip.
      if (inventoryCount(world, entityId, step.itemType) >= step.quantity) continue;
      return step;
    }
    if (step.kind === "gather") {
      if (inventoryCount(world, entityId, step.itemType) >= step.quantity) continue;
      return step;
    }
    // craftAt steps never auto-satisfy — we always need to physically do them.
    return step;
  }
  return null;
}

function currentJobMatchesStep(current: import("@voxim/codecs").Job | null, step: CraftingPlanStep): boolean {
  if (!current) return false;
  if (step.kind === "gather" && current.type === "gatherResource") {
    return current.itemType === step.itemType;
  }
  if (step.kind === "craftAt" && current.type === "craftAtWorkbench") {
    return current.workbenchType === step.workbenchType;
  }
  return false;
}

function stepToJob(step: CraftingPlanStep, currentTick: number): import("@voxim/codecs").Job {
  if (step.kind === "gather") {
    return {
      type: "gatherResource",
      itemType: step.itemType,
      targetQuantity: step.quantity,
      resourceNodeTypes: [...step.resourceNodeTypes],
      nodeId: null,
      expiresAt: currentTick + 600,
    };
  }
  if (step.kind === "craftAt") {
    return {
      type: "craftAtWorkbench",
      workbenchType: step.workbenchType,
      inputs: step.inputs.map((i) => ({ itemType: i.itemType, quantity: i.quantity })),
      workbenchId: null,
      phase: "approach",
      expiresAt: currentTick + 600,
    };
  }
  // fetch — degenerate, we've already accounted for it in firstPendingStep.
  // Emit an idle to keep the type exhaustive.
  return { type: "idle", expiresAt: currentTick + 20 };
}
