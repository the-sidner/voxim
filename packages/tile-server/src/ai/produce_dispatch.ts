/**
 * produceDispatch — shared helpers for "make NPC acquire N of item X".
 *
 * Two callers consume this: the static-goal try_produce BT node (W3) and
 * the dynamic-goal job-board executor (W5). They differ only in where the
 * target item comes from — the planner invocation, WorldView construction,
 * step-dispatch, and sub-job synthesis are identical.
 */
import type { World, EntityId } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import type { InventoryData, Job } from "@voxim/codecs";
import { Inventory } from "../components/items.ts";
import { ResourceNode } from "../components/resource_node.ts";
import { WorkstationTag } from "../components/building.ts";
import { Position } from "../components/game.ts";
import { plan as runPlanner } from "./crafting_planner.ts";
import type { WorldView, CraftingPlanStep } from "./crafting_planner.ts";

export type DispatchOutcome =
  | { kind: "alreadyHave" }
  | { kind: "emit"; job: Job }
  | { kind: "sameAsCurrent" }
  | { kind: "unreachable" };

export function inventoryCount(world: World, entityId: EntityId, itemType: string): number {
  const inv = world.get(entityId, Inventory);
  if (!inv) return 0;
  let total = 0;
  for (const s of inv.slots) if (s.kind === "stack" && s.prefabId === itemType) total += s.quantity;
  return total;
}

function inventorySnapshot(world: World, entityId: EntityId): InventoryData {
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
    if (step.kind === "fetch" || step.kind === "gather") {
      if (inventoryCount(world, entityId, step.itemType) >= step.quantity) continue;
      return step;
    }
    // craftAt steps never auto-satisfy.
    return step;
  }
  return null;
}

function currentJobMatchesStep(current: Job | null, step: CraftingPlanStep): boolean {
  if (!current) return false;
  if (step.kind === "gather" && current.type === "gatherResource") {
    return current.itemType === step.itemType;
  }
  if (step.kind === "craftAt" && current.type === "craftAtWorkbench") {
    return current.workbenchType === step.workbenchType;
  }
  return false;
}

function stepToJob(step: CraftingPlanStep, currentTick: number): Job {
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
  return { type: "idle", expiresAt: currentTick + 20 };
}

/**
 * Decide what to do this tick to progress toward "entityId has quantity of
 * targetItem in its Inventory." Returns the next sub-job to emit, or a
 * terminal outcome.
 *
 * Caller responsibility: if outcome is "emit", write the job via
 * `out.replaceCurrent` (or equivalent). If "sameAsCurrent", the NPC's
 * running sub-job already implements the step — leave the queue alone.
 */
export function dispatchProduce(
  world: World,
  content: ContentStore,
  entityId: EntityId,
  px: number,
  py: number,
  currentJob: Job | null,
  targetItem: string,
  quantity: number,
  scanRadius: number,
  currentTick: number,
): DispatchOutcome {
  if (inventoryCount(world, entityId, targetItem) >= quantity) {
    return { kind: "alreadyHave" };
  }

  const view = buildWorldView(world, content, px, py, scanRadius);
  const graph = content.getRecipeGraph();
  const plan = runPlanner(targetItem, quantity, inventorySnapshot(world, entityId), view, graph);
  if (!plan || plan.steps.length === 0) return { kind: "unreachable" };

  const step = firstPendingStep(plan.steps, world, entityId);
  if (!step) return { kind: "alreadyHave" };

  if (currentJobMatchesStep(currentJob, step)) return { kind: "sameAsCurrent" };
  return { kind: "emit", job: stepToJob(step, currentTick) };
}
