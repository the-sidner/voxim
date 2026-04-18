import { assertEquals, assert } from "jsr:@std/assert";
import { buildRecipeGraph } from "./recipe_graph.ts";
import type { Recipe } from "./types.ts";

/** Minimal recipe helper — only fields the graph actually reads. */
function recipe(
  id: string,
  inputs: Array<{ itemType: string; quantity: number; alternates?: string[] }>,
  outputs: Array<{ itemType: string; quantity: number }>,
  stationType?: string,
): Recipe {
  return {
    id,
    stationType,
    requiredTools: [],
    inputs,
    outputs,
    ticks: 0,
  };
}

Deno.test("producers maps output items to their recipes", () => {
  const r = recipe("forge_iron", [{ itemType: "iron_ore", quantity: 1 }], [{ itemType: "iron_ingot", quantity: 1 }]);
  const g = buildRecipeGraph([r]);
  assertEquals(g.producers.get("iron_ingot"), [r]);
});

Deno.test("producers groups multiple recipes that share an output", () => {
  const r1 = recipe("from_ore",    [{ itemType: "iron_ore", quantity: 1 }],   [{ itemType: "iron_ingot", quantity: 1 }]);
  const r2 = recipe("from_scrap",  [{ itemType: "iron_scrap", quantity: 2 }], [{ itemType: "iron_ingot", quantity: 1 }]);
  const g = buildRecipeGraph([r1, r2]);
  assertEquals(g.producers.get("iron_ingot")?.length, 2);
});

Deno.test("byStation groups recipes by workstation type", () => {
  const r1 = recipe("a", [{ itemType: "x", quantity: 1 }], [{ itemType: "y", quantity: 1 }], "anvil");
  const r2 = recipe("b", [{ itemType: "x", quantity: 1 }], [{ itemType: "z", quantity: 1 }], "anvil");
  const r3 = recipe("c", [{ itemType: "x", quantity: 1 }], [{ itemType: "w", quantity: 1 }], "furnace");
  const g = buildRecipeGraph([r1, r2, r3]);
  assertEquals(g.byStation.get("anvil")?.length, 2);
  assertEquals(g.byStation.get("furnace")?.length, 1);
});

Deno.test("recipes without a stationType group under the empty string", () => {
  const r = recipe("hand", [{ itemType: "x", quantity: 1 }], [{ itemType: "y", quantity: 1 }]);
  const g = buildRecipeGraph([r]);
  assertEquals(g.byStation.get("")?.length, 1);
});

Deno.test("primitives are inputs that no recipe produces", () => {
  // ore → ingot → sword. ore is gathered (primitive); ingot and sword are produced.
  const smelt = recipe("smelt", [{ itemType: "ore", quantity: 1 }],   [{ itemType: "ingot", quantity: 1 }]);
  const forge = recipe("forge", [{ itemType: "ingot", quantity: 1 }], [{ itemType: "sword", quantity: 1 }]);
  const g = buildRecipeGraph([smelt, forge]);
  assert(g.primitives.has("ore"), "ore should be primitive");
  assert(!g.primitives.has("ingot"), "ingot is produced by smelt");
  assert(!g.primitives.has("sword"), "sword is produced by forge");
});

Deno.test("alternates contribute to primitive detection", () => {
  // recipe accepts oak_plank or pine_plank. Neither is produced; both are primitive.
  const r = recipe("hut", [{ itemType: "oak_plank", quantity: 4, alternates: ["pine_plank"] }], [{ itemType: "hut", quantity: 1 }]);
  const g = buildRecipeGraph([r]);
  assert(g.primitives.has("oak_plank"));
  assert(g.primitives.has("pine_plank"));
});

Deno.test("items that are both input and output are not primitive", () => {
  // recycling: broken_sword + ore → ingot, and ingot → sword. ingot is both input AND output.
  const recycle = recipe("recycle", [{ itemType: "broken_sword", quantity: 1 }, { itemType: "ore", quantity: 1 }], [{ itemType: "ingot", quantity: 1 }]);
  const forge   = recipe("forge",   [{ itemType: "ingot", quantity: 1 }],                                        [{ itemType: "sword", quantity: 1 }]);
  const g = buildRecipeGraph([recycle, forge]);
  assert(g.primitives.has("broken_sword"));
  assert(g.primitives.has("ore"));
  assert(!g.primitives.has("ingot"), "ingot is also an output, not primitive");
});

Deno.test("items that don't appear as inputs don't appear in the graph primitive set", () => {
  const r = recipe("craft", [{ itemType: "wood", quantity: 1 }], [{ itemType: "chair", quantity: 1 }]);
  const g = buildRecipeGraph([r]);
  assert(!g.primitives.has("chair"), "chair is an output, not input, so not primitive");
  assert(!g.primitives.has("nonexistent"), "random item not in the graph is not primitive");
});

Deno.test("empty recipe list yields empty graph", () => {
  const g = buildRecipeGraph([]);
  assertEquals(g.producers.size, 0);
  assertEquals(g.byStation.size, 0);
  assertEquals(g.primitives.size, 0);
});

Deno.test("ContentStore graph is cached across calls but rebuilt after registerRecipe", async () => {
  const { StaticContentStore } = await import("./store.ts");
  const store = new StaticContentStore();
  store.registerRecipe(recipe("r1", [{ itemType: "a", quantity: 1 }], [{ itemType: "b", quantity: 1 }]));
  const g1 = store.getRecipeGraph();
  const g2 = store.getRecipeGraph();
  assert(g1 === g2, "same instance returned twice without a new register");
  store.registerRecipe(recipe("r2", [{ itemType: "b", quantity: 1 }], [{ itemType: "c", quantity: 1 }]));
  const g3 = store.getRecipeGraph();
  assert(g1 !== g3, "new registration invalidates the cache");
  assert(!g3.primitives.has("b"), "b is now produced by r1");
});
