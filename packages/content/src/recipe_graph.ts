/**
 * Recipe reverse index — answers two queries in O(1) after build:
 *
 *   producers.get(itemType) — which recipes produce this item
 *   byStation.get(stationType) — which recipes this workstation type supports
 *   primitives.has(itemType) — this item appears as an input but no recipe
 *                              produces it (so it must be gathered from a
 *                              resource node or spawned directly)
 *
 * Built once at content-load. CraftingPlanner (W1) and the goal-regression
 * BT nodes (W2, W3) consume the graph; no runtime mutation.
 *
 * Primitive detection is the single interesting algorithm here: an item is a
 * primitive iff (a) at least one recipe consumes it as an input, and (b) no
 * recipe's output list contains it. An item that is neither input nor output
 * of any recipe (e.g. display-only props) is not a primitive — it simply
 * doesn't participate in the graph.
 */
import type { Recipe } from "./types.ts";

export interface RecipeGraph {
  /** itemType → recipes whose outputs include this item. */
  readonly producers: ReadonlyMap<string, readonly Recipe[]>;
  /** stationType → recipes requiring that workstation. Recipes without a
   *  stationType are grouped under the empty string. */
  readonly byStation: ReadonlyMap<string, readonly Recipe[]>;
  /** itemTypes consumed by some recipe but produced by none. */
  readonly primitives: ReadonlySet<string>;
}

export function buildRecipeGraph(recipes: readonly Recipe[]): RecipeGraph {
  const producers = new Map<string, Recipe[]>();
  const byStation = new Map<string, Recipe[]>();
  const allInputs = new Set<string>();
  const allOutputs = new Set<string>();

  for (const recipe of recipes) {
    for (const output of recipe.outputs) {
      allOutputs.add(output.itemType);
      const list = producers.get(output.itemType);
      if (list) list.push(recipe);
      else producers.set(output.itemType, [recipe]);
    }

    const station = recipe.stationType ?? "";
    const stationList = byStation.get(station);
    if (stationList) stationList.push(recipe);
    else byStation.set(station, [recipe]);

    for (const input of recipe.inputs) {
      allInputs.add(input.itemType);
      if (input.alternates) for (const alt of input.alternates) allInputs.add(alt);
    }
  }

  const primitives = new Set<string>();
  for (const itemType of allInputs) {
    if (!allOutputs.has(itemType)) primitives.add(itemType);
  }

  return { producers, byStation, primitives };
}
