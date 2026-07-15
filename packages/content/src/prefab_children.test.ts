import { assertEquals, assertThrows } from "jsr:@std/assert";
import { validatePrefabChildRefs, validatePrefabFields } from "./loader.ts";
import { StaticContentStore } from "./store.ts";
import type { Prefab } from "./types.ts";

/**
 * T-334 — content-loader validation for the seeded pool/probability
 * vocabulary on `Prefab.children`. Mirrors the pre-existing prefabId-only
 * checks (unknown/abstract child refs fail loud at load) plus the new
 * `pool`/`probability` shape rules.
 */

function makePrefab(children: Prefab["children"]): Prefab {
  return { id: "p", components: {}, children };
}

// ---- validatePrefabFields (per-prefab shape) ----

Deno.test("validatePrefabFields: bare prefabId child (T-217, unchanged) passes", () => {
  validatePrefabFields(makePrefab([{ prefabId: "leaf" }]));
});

Deno.test("validatePrefabFields: pool + probability child passes", () => {
  validatePrefabFields(makePrefab([{ pool: ["a", "b", "c"], probability: 0.5 }]));
});

Deno.test("validatePrefabFields: neither prefabId nor pool throws", () => {
  assertThrows(
    () => validatePrefabFields(makePrefab([{ local: { x: 1 } }])),
    Error,
    "needs a prefabId or a pool",
  );
});

Deno.test("validatePrefabFields: empty pool array throws", () => {
  assertThrows(
    () => validatePrefabFields(makePrefab([{ pool: [] }])),
    Error,
    "pool must be a non-empty array",
  );
});

Deno.test("validatePrefabFields: non-string pool entry throws", () => {
  // deno-lint-ignore no-explicit-any
  const bad = [{ pool: ["a", 5 as any] }];
  assertThrows(
    () => validatePrefabFields(makePrefab(bad)),
    Error,
    "pool entries must be non-empty strings",
  );
});

Deno.test("validatePrefabFields: probability out of [0,1] throws", () => {
  assertThrows(
    () => validatePrefabFields(makePrefab([{ prefabId: "leaf", probability: 1.5 }])),
    Error,
    "probability must be a number in [0, 1]",
  );
  assertThrows(
    () => validatePrefabFields(makePrefab([{ prefabId: "leaf", probability: -0.1 }])),
    Error,
    "probability must be a number in [0, 1]",
  );
});

Deno.test("validatePrefabFields: probability at the boundaries (0 and 1) is valid", () => {
  validatePrefabFields(makePrefab([{ prefabId: "leaf", probability: 0 }]));
  validatePrefabFields(makePrefab([{ prefabId: "leaf", probability: 1 }]));
});

Deno.test("validatePrefabFields: pool AND prefabId both set is accepted (pool wins at spawn time)", () => {
  validatePrefabFields(makePrefab([{ prefabId: "leaf", pool: ["a", "b"] }]));
});

// ---- validatePrefabChildRefs (cross-referenced against the full prefab set) ----

function makeStore(prefabs: Prefab[]): StaticContentStore {
  const store = new StaticContentStore();
  for (const p of prefabs) store.registerPrefab(p);
  return store;
}

Deno.test("validatePrefabChildRefs: pool entries all resolving to concrete prefabs passes", () => {
  const store = makeStore([
    makePrefab([{ pool: ["a", "b"] }]),
    { id: "a", components: {} },
    { id: "b", components: {} },
  ]);
  validatePrefabChildRefs(store);
});

Deno.test("validatePrefabChildRefs: a pool entry referencing an unknown prefab throws", () => {
  const store = makeStore([
    makePrefab([{ pool: ["a", "ghost"] }]),
    { id: "a", components: {} },
  ]);
  assertThrows(
    () => validatePrefabChildRefs(store),
    Error,
    "child references unknown prefab 'ghost'",
  );
});

Deno.test("validatePrefabChildRefs: a pool entry referencing an abstract prefab throws", () => {
  const store = makeStore([
    makePrefab([{ pool: ["a", "_base"] }]),
    { id: "a", components: {} },
    { id: "_base", components: {} },
  ]);
  assertThrows(
    () => validatePrefabChildRefs(store),
    Error,
    "child '_base' is abstract",
  );
});

Deno.test("validatePrefabChildRefs: prefabId set alongside pool is still cross-checked (defensive, even though pool wins at spawn)", () => {
  const store = makeStore([
    makePrefab([{ prefabId: "ghost", pool: ["a"] }]),
    { id: "a", components: {} },
  ]);
  assertThrows(
    () => validatePrefabChildRefs(store),
    Error,
    "child references unknown prefab 'ghost'",
  );
});

Deno.test("validatePrefabChildRefs: dedupes an id appearing as both prefabId and in pool (no double error)", () => {
  const store = makeStore([
    makePrefab([{ prefabId: "a", pool: ["a", "b"] }]),
    { id: "a", components: {} },
    { id: "b", components: {} },
  ]);
  validatePrefabChildRefs(store);
});
