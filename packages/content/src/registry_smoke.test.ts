/**
 * T-174 smoke test — proves ContentRegistry<MaterialDef> works against
 * the real on-disk materials. Validates that tag indexing returns the
 * expected categorical queries (metals, organics, ground) and that
 * registering every loaded material is duplicate-free.
 *
 * Note: this is an integration test, not a unit test. It depends on
 * loadContentStore() and the materials/*.json files. Marked as
 * separate from the pure registry.test.ts so the unit tests run fast.
 */

import { assertEquals } from "jsr:@std/assert";
import { ContentRegistry } from "./registry.ts";
import { loadContentStore } from "./loader.ts";
import type { MaterialDef } from "./types.ts";

Deno.test("ContentRegistry<MaterialDef> indexes real materials by tag", async () => {
  const store = await loadContentStore();
  const reg = new ContentRegistry<MaterialDef>({
    kind: "material",
    idOf: (m) => m.name,
  });
  for (const m of store.getAllMaterials()) reg.register(m);

  // Subset checks — concrete tags we authored, names must be present.
  const metals = reg.byTag("metal").map((m) => m.name).sort();
  assertEquals(
    metals,
    ["copper", "iron", "steel", "worn_iron"],
  );

  const ironLike = reg.byTag("iron").map((m) => m.name).sort();
  // "iron", "steel" (alloy), and "worn_iron" all share the iron tag
  assertEquals(ironLike, ["iron", "steel", "worn_iron"]);

  const flesh = reg.byTag("flesh").map((m) => m.name).sort();
  assertEquals(flesh, ["drowner_flesh", "skin"]);

  const wood = reg.byTag("wood").map((m) => m.name).sort();
  assertEquals(wood, ["oak", "pine", "wood"]);

  // Untagged materials still register cleanly.
  for (const m of reg.values()) {
    assertEquals(typeof m.id, "number");
  }
});
