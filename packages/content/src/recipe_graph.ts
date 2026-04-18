/**
 * Item-sourcing reverse index — answers the planner's "where does X come
 * from" queries in O(1) after build:
 *
 *   producers.get(itemType)  — recipes whose outputs include the item
 *   byStation.get(station)   — recipes requiring a specific workstation
 *   gatherers.get(itemType)  — resource-node prefab ids whose yields include
 *                              the item
 *   primitives.has(itemType) — item is consumed by some recipe but produced
 *                              by no recipe (must come from a gatherer)
 *
 * Built once at content-load from the full (recipes, prefabs) pair.
 * CraftingPlanner (W1) and the TryProduce BT node (W3) consume the graph;
 * no runtime mutation.
 *
 * Primitive detection: an item is primitive iff (a) at least one recipe
 * consumes it and (b) no recipe's output list contains it. An item that is
 * neither input nor output of any recipe (display-only props) doesn't
 * participate in the graph.
 */
import type { Recipe, Prefab, PrefabResourceNodeData } from "./types.ts";

export interface RecipeGraph {
  /** itemType → recipes whose outputs include this item. */
  readonly producers: ReadonlyMap<string, readonly Recipe[]>;
  /** stationType → recipes requiring that workstation. Recipes without a
   *  stationType are grouped under the empty string. */
  readonly byStation: ReadonlyMap<string, readonly Recipe[]>;
  /** itemType → resource-node prefab ids whose yields include this item. */
  readonly gatherers: ReadonlyMap<string, readonly string[]>;
  /** itemTypes consumed by some recipe but produced by none. */
  readonly primitives: ReadonlySet<string>;
}

export function buildRecipeGraph(
  recipes: readonly Recipe[],
  prefabs: readonly Prefab[] = [],
): RecipeGraph {
  const producers = new Map<string, Recipe[]>();
  const byStation = new Map<string, Recipe[]>();
  const gatherers = new Map<string, string[]>();
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

  for (const prefab of prefabs) {
    const rn = prefab.components.resourceNode as PrefabResourceNodeData | undefined;
    if (!rn) continue;
    for (const y of rn.yields) {
      const list = gatherers.get(y.itemType);
      if (list) { if (!list.includes(prefab.id)) list.push(prefab.id); }
      else gatherers.set(y.itemType, [prefab.id]);
    }
  }

  const primitives = new Set<string>();
  for (const itemType of allInputs) {
    if (!allOutputs.has(itemType)) primitives.add(itemType);
  }

  return { producers, byStation, gatherers, primitives };
}
