/**
 * Procmodel generator registry + boot cross-check (T-285a). The registry is
 * THREE-free, so it runs headless. Pins: built-in registration is idempotent,
 * the cross-check resolves real content and fails fast on a typo, and the
 * tree_grammar STUB produces a deterministic, well-formed trunk column.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { JsonSource } from "@voxim/content";
import { getGenerator, generatorIds, registerBuiltinGenerators, crossCheckProcModels } from "./mod.ts";

const content = await JsonSource.load("packages/content/data");

Deno.test("T-285a: built-in generators register (idempotent) and tree_grammar resolves", () => {
  registerBuiltinGenerators();
  registerBuiltinGenerators(); // second call is a no-op, not a double-register throw
  assert(generatorIds().includes("tree_grammar"));
  assert(getGenerator("tree_grammar"), "tree_grammar resolvable");
});

Deno.test("T-285a: crossCheckProcModels passes on the real content", () => {
  crossCheckProcModels(content); // throws on a typo — reaching here is the pass
});

Deno.test("T-285a: the stub generator emits a deterministic trunk column in FULL edge lengths", () => {
  const gen = getGenerator("tree_grammar")!;
  const ctx = { resolveMaterial: (name: string) => content.materials.get(name)!.id };
  const params = content.procModels.get("oak")!.params;
  const a = gen(12345, params, ctx);
  const b = gen(12345, params, ctx);
  assertEquals(a, b, "same seed → same atoms (deterministic)");
  assert(a.length >= 6 && a.length <= 11, `trunk height in [6,11], got ${a.length}`);
  for (const atom of a) {
    assertEquals([atom.sx, atom.sy, atom.sz], [1, 1, 1], "unit voxels (full edge length 1)");
    assertEquals(atom.materialId, content.materials.get("wood")!.id, "trunk is wood");
  }
});

Deno.test("T-285a: cross-check throws on an unknown generator", () => {
  const bad = {
    procModels: { values: () => [{ id: "broken", generator: "no_such_generator", params: {} }] },
    scatter: { values: () => [] },
  } as unknown as Parameters<typeof crossCheckProcModels>[0];
  let threw = false;
  try { crossCheckProcModels(bad); } catch { threw = true; }
  assert(threw, "unknown generator id rejected");
});
