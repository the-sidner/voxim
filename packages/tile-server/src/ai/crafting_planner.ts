/**
 * CraftingPlanner — pure function from (target, inventory, world view, recipe
 * graph) to an ordered CraftingPlan or null.
 *
 * The planner is stateless. BT nodes call it, cache the result on the NPC,
 * walk the steps, and re-plan on failure. No world mutation, no side effects.
 *
 * Algorithm: depth-first goal regression starting from `target`.
 *   1. If inventory already satisfies the quantity → single `fetch` step.
 *   2. If `target` is a primitive (graph.primitives) → `gather` step, if a
 *      resource-node prefab for it is in range.
 *   3. Otherwise try each producing recipe:
 *      - Skip if its stationType isn't placed on the tile.
 *      - Recurse on each input (quantity defaults to recipe input qty).
 *      - If every input resolves, emit a `craftAt` step with sub-plans
 *        prepended.
 *      - Rank successful candidates by total step count (shortest wins).
 *
 * Cycle and depth guards keep content bugs (accidentally cyclic recipe
 * graphs) from DoS'ing the planner.
 *
 * Null means "unreachable" — the caller clears any stored plan and tries
 * again next tick; environment changes (new workbench placed, node respawn)
 * can unblock a previously-null result.
 */
import type { InventoryData } from "@voxim/codecs";
import type { RecipeGraph, Recipe, RecipeInput } from "@voxim/content";
import type { EntityId } from "@voxim/engine";

export interface GatherStep {
  readonly kind: "gather";
  readonly itemType: string;
  /** Resource-node prefab ids known to yield this item. The BT picks a reachable one. */
  readonly resourceNodeTypes: readonly string[];
  readonly quantity: number;
}

export interface CraftAtStep {
  readonly kind: "craftAt";
  readonly recipeId: string;
  /** "" for handcraft recipes with no stationType. */
  readonly workbenchType: string;
  readonly inputs: readonly RecipeInput[];
}

export interface FetchStep {
  readonly kind: "fetch";
  readonly itemType: string;
  readonly from: "inventory" | "buffer";
  readonly quantity: number;
}

export type CraftingPlanStep = GatherStep | CraftAtStep | FetchStep;

export interface CraftingPlan {
  readonly target: string;
  readonly steps: readonly CraftingPlanStep[];
}

/**
 * Lightweight view of the world passed into the planner. Built by the BT
 * node before invocation — it carries only what the algorithm needs, not a
 * full ContentStore or SpatialGrid handle.
 */
export interface WorldView {
  /** workstationType → entity ids of placed workstations of that type. */
  readonly placedWorkbenches: ReadonlyMap<string, readonly EntityId[]>;
  /** itemType → resource-node prefab ids known to yield it. */
  readonly gatherersByItem: ReadonlyMap<string, readonly string[]>;
  /** True when at least one resource-node of the right type is within the NPC's gather range. */
  readonly nearbyResourceNodes: (itemType: string) => boolean;
}

const DEFAULT_MAX_DEPTH = 16;

export function plan(
  target: string,
  quantity: number,
  inventory: InventoryData,
  world: WorldView,
  graph: RecipeGraph,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): CraftingPlan | null {
  const steps = resolve(target, quantity, inventory, world, graph, 0, maxDepth, new Set());
  return steps ? { target, steps } : null;
}

function resolve(
  target: string,
  quantity: number,
  inventory: InventoryData,
  world: WorldView,
  graph: RecipeGraph,
  depth: number,
  maxDepth: number,
  visited: ReadonlySet<string>,
): CraftingPlanStep[] | null {
  if (depth > maxDepth) return null;
  if (visited.has(target)) return null;

  // 1. Already have enough in inventory.
  if (inventoryHas(inventory, target) >= quantity) {
    return [{ kind: "fetch", itemType: target, from: "inventory", quantity }];
  }

  // 2. Primitive — must be gathered from a resource node.
  if (graph.primitives.has(target)) {
    const gatherers = world.gatherersByItem.get(target);
    if (!gatherers || gatherers.length === 0) return null;
    if (!world.nearbyResourceNodes(target)) return null;
    return [{ kind: "gather", itemType: target, resourceNodeTypes: gatherers, quantity }];
  }

  // 3. Try each producing recipe. Rank candidates by step count.
  const recipes = graph.producers.get(target);
  if (!recipes || recipes.length === 0) return null;

  let best: CraftingPlanStep[] | null = null;
  const nextVisited = new Set(visited).add(target);

  for (const recipe of recipes) {
    const steps = tryRecipe(recipe, inventory, world, graph, depth, maxDepth, nextVisited);
    if (!steps) continue;
    if (!best || steps.length < best.length) best = steps;
  }
  return best;
}

function tryRecipe(
  recipe: Recipe,
  inventory: InventoryData,
  world: WorldView,
  graph: RecipeGraph,
  depth: number,
  maxDepth: number,
  visited: ReadonlySet<string>,
): CraftingPlanStep[] | null {
  const station = recipe.stationType ?? "";
  if (station && !world.placedWorkbenches.has(station)) return null;

  const out: CraftingPlanStep[] = [];
  for (const input of recipe.inputs) {
    const subSteps = resolve(input.itemType, input.quantity, inventory, world, graph, depth + 1, maxDepth, visited);
    if (!subSteps) return null;
    out.push(...subSteps);
  }
  out.push({
    kind: "craftAt",
    recipeId: recipe.id,
    workbenchType: station,
    inputs: recipe.inputs,
  });
  return out;
}

/** Sum the quantity of an item across all inventory slots. */
function inventoryHas(inventory: InventoryData, itemType: string): number {
  let total = 0;
  for (const slot of inventory.slots) {
    if (slot.kind === "stack" && slot.prefabId === itemType) total += slot.quantity;
  }
  return total;
}
