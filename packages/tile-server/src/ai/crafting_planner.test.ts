import { assertEquals, assertExists } from "jsr:@std/assert";
import { buildRecipeGraph } from "@voxim/content";
import type { Recipe } from "@voxim/content";
import type { InventoryData } from "@voxim/codecs";
import { plan } from "./crafting_planner.ts";
import type { WorldView } from "./crafting_planner.ts";

// ── test helpers ─────────────────────────────────────────────────────────

function recipe(
  id: string,
  inputs: Array<{ itemType: string; quantity: number }>,
  outputs: Array<{ itemType: string; quantity: number }>,
  stationType?: string,
): Recipe {
  return { id, stationType, requiredTools: [], inputs, outputs, ticks: 0 };
}

const emptyInv: InventoryData = { slots: [], capacity: 20 };

function inv(items: Array<{ itemType: string; quantity: number }>): InventoryData {
  return {
    slots: items.map((i) => ({ kind: "stack" as const, prefabId: i.itemType, quantity: i.quantity })),
    capacity: 20,
  };
}

function worldWith(opts: {
  workbenches?: string[];
  gatherers?: Record<string, string[]>;
  nearby?: Set<string>;
}): WorldView {
  return {
    placedWorkbenches: new Map((opts.workbenches ?? []).map((w) => [w, ["entity-" + w]])),
    gatherersByItem: new Map(Object.entries(opts.gatherers ?? {})),
    nearbyResourceNodes: (it) => (opts.nearby ?? new Set()).has(it),
  };
}

// ── tests ────────────────────────────────────────────────────────────────

Deno.test("target already in inventory → single fetch step", () => {
  const graph = buildRecipeGraph([]);
  const p = plan("wood", 3, inv([{ itemType: "wood", quantity: 5 }]), worldWith({}), graph);
  assertExists(p);
  assertEquals(p.steps.length, 1);
  assertEquals(p.steps[0], { kind: "fetch", itemType: "wood", from: "inventory", quantity: 3 });
});

Deno.test("primitive target → gather step, when node nearby", () => {
  const graph = buildRecipeGraph([
    recipe("smelt", [{ itemType: "iron_ore", quantity: 1 }], [{ itemType: "iron_ingot", quantity: 1 }]),
  ]);
  const p = plan(
    "iron_ore", 2, emptyInv,
    worldWith({ gatherers: { iron_ore: ["iron_ore_vein"] }, nearby: new Set(["iron_ore"]) }),
    graph,
  );
  assertExists(p);
  assertEquals(p.steps.length, 1);
  assertEquals(p.steps[0], {
    kind: "gather", itemType: "iron_ore", resourceNodeTypes: ["iron_ore_vein"], quantity: 2,
  });
});

Deno.test("primitive target with no nearby node → null", () => {
  const graph = buildRecipeGraph([
    recipe("smelt", [{ itemType: "iron_ore", quantity: 1 }], [{ itemType: "iron_ingot", quantity: 1 }]),
  ]);
  const p = plan(
    "iron_ore", 1, emptyInv,
    worldWith({ gatherers: { iron_ore: ["iron_ore_vein"] }, nearby: new Set() }),
    graph,
  );
  assertEquals(p, null);
});

Deno.test("simple multi-step plan: gather → craft", () => {
  const graph = buildRecipeGraph([
    recipe("smelt",
      [{ itemType: "iron_ore", quantity: 1 }],
      [{ itemType: "iron_ingot", quantity: 1 }],
      "furnace",
    ),
  ]);
  const p = plan(
    "iron_ingot", 1, emptyInv,
    worldWith({
      workbenches: ["furnace"],
      gatherers: { iron_ore: ["iron_ore_vein"] },
      nearby: new Set(["iron_ore"]),
    }),
    graph,
  );
  assertExists(p);
  assertEquals(p.steps.length, 2);
  assertEquals(p.steps[0].kind, "gather");
  assertEquals(p.steps[1].kind, "craftAt");
});

Deno.test("multi-input recipe: both inputs gathered before craft", () => {
  const graph = buildRecipeGraph([
    recipe("sword",
      [
        { itemType: "iron_ingot", quantity: 1 },
        { itemType: "wood",       quantity: 1 },
      ],
      [{ itemType: "iron_sword", quantity: 1 }],
      "anvil",
    ),
    recipe("smelt",
      [{ itemType: "iron_ore", quantity: 1 }],
      [{ itemType: "iron_ingot", quantity: 1 }],
      "furnace",
    ),
  ]);
  const p = plan(
    "iron_sword", 1, emptyInv,
    worldWith({
      workbenches: ["anvil", "furnace"],
      gatherers: { iron_ore: ["iron_ore_vein"], wood: ["tree"] },
      nearby: new Set(["iron_ore", "wood"]),
    }),
    graph,
  );
  assertExists(p);
  // gather ore → craft ingot → gather wood → forge sword (4 steps)
  assertEquals(p.steps.length, 4);
  assertEquals(p.steps[0], {
    kind: "gather", itemType: "iron_ore", resourceNodeTypes: ["iron_ore_vein"], quantity: 1,
  });
  assertEquals(p.steps[1].kind, "craftAt");
  assertEquals(p.steps[2], {
    kind: "gather", itemType: "wood", resourceNodeTypes: ["tree"], quantity: 1,
  });
  assertEquals(p.steps[3].kind, "craftAt");
});

Deno.test("partial inventory: one input covered → only remaining gather", () => {
  const graph = buildRecipeGraph([
    recipe("sword",
      [
        { itemType: "iron_ingot", quantity: 1 },
        { itemType: "wood",       quantity: 1 },
      ],
      [{ itemType: "iron_sword", quantity: 1 }],
      "anvil",
    ),
  ]);
  const p = plan(
    "iron_sword", 1,
    inv([{ itemType: "iron_ingot", quantity: 1 }, { itemType: "wood", quantity: 1 }]),
    worldWith({ workbenches: ["anvil"] }),
    graph,
  );
  assertExists(p);
  // Both inputs are in inventory → two fetch steps + one craftAt.
  assertEquals(p.steps.length, 3);
  assertEquals(p.steps[0].kind, "fetch");
  assertEquals(p.steps[1].kind, "fetch");
  assertEquals(p.steps[2].kind, "craftAt");
});

Deno.test("recipe requires a station that isn't placed → null", () => {
  const graph = buildRecipeGraph([
    recipe("smelt",
      [{ itemType: "iron_ore", quantity: 1 }],
      [{ itemType: "iron_ingot", quantity: 1 }],
      "furnace",
    ),
  ]);
  const p = plan(
    "iron_ingot", 1, emptyInv,
    worldWith({
      workbenches: [],  // no furnace
      gatherers: { iron_ore: ["iron_ore_vein"] },
      nearby: new Set(["iron_ore"]),
    }),
    graph,
  );
  assertEquals(p, null);
});

Deno.test("recipe with empty stationType is handcraft (no workbench needed)", () => {
  const graph = buildRecipeGraph([
    recipe("tinder", [{ itemType: "wood", quantity: 1 }], [{ itemType: "tinder", quantity: 1 }]),
  ]);
  const p = plan(
    "tinder", 1, emptyInv,
    worldWith({
      gatherers: { wood: ["tree"] },
      nearby: new Set(["wood"]),
    }),
    graph,
  );
  assertExists(p);
  assertEquals(p.steps.length, 2);
  assertEquals((p.steps[1] as { kind: string; workbenchType: string }).workbenchType, "");
});

Deno.test("choice between two recipes → shorter plan wins", () => {
  // Recipe A: one input (wood). Recipe B: two inputs (wood + stone).
  // Both produce "stick". Planner should pick A.
  const graph = buildRecipeGraph([
    recipe("stick_simple",  [{ itemType: "wood", quantity: 1 }],                                        [{ itemType: "stick", quantity: 1 }]),
    recipe("stick_fancy",   [{ itemType: "wood", quantity: 1 }, { itemType: "stone", quantity: 1 }],    [{ itemType: "stick", quantity: 1 }]),
  ]);
  const p = plan(
    "stick", 1, emptyInv,
    worldWith({
      gatherers: { wood: ["tree"], stone: ["rock"] },
      nearby: new Set(["wood", "stone"]),
    }),
    graph,
  );
  assertExists(p);
  assertEquals(p.steps.length, 2);
});

Deno.test("cycle in recipe graph → null (guarded)", () => {
  // Synthetic cycle: a → b → a. Neither is primitive.
  const graph = buildRecipeGraph([
    recipe("r_ab", [{ itemType: "a", quantity: 1 }], [{ itemType: "b", quantity: 1 }]),
    recipe("r_ba", [{ itemType: "b", quantity: 1 }], [{ itemType: "a", quantity: 1 }]),
  ]);
  const p = plan("a", 1, emptyInv, worldWith({}), graph);
  assertEquals(p, null);
});

Deno.test("depth guard terminates pathological chains", () => {
  // 30-deep chain: i_n → i_{n+1}, primitive at i_30.
  const recipes: Recipe[] = [];
  for (let n = 0; n < 30; n++) {
    recipes.push(recipe(`r_${n}`, [{ itemType: `i_${n + 1}`, quantity: 1 }], [{ itemType: `i_${n}`, quantity: 1 }]));
  }
  const graph = buildRecipeGraph(recipes);
  const p = plan(
    "i_0", 1, emptyInv,
    worldWith({ gatherers: { "i_30": ["src"] }, nearby: new Set(["i_30"]) }),
    graph,
    16,  // depth cap below the chain length
  );
  assertEquals(p, null);
});

Deno.test("unreachable primitive (no gatherer known) → null", () => {
  const graph = buildRecipeGraph([
    recipe("mix", [{ itemType: "unobtainium", quantity: 1 }], [{ itemType: "alloy", quantity: 1 }]),
  ]);
  const p = plan("alloy", 1, emptyInv, worldWith({}), graph);
  assertEquals(p, null);
});
