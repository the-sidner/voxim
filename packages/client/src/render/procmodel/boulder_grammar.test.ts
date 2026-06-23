/**
 * boulder_grammar (T-285d) — the second generator, proving the primitive
 * generalizes with zero renderer edits. Pins: deterministic, varied across
 * seeds, a solid stone blob, bounded, and bakes crack-free. Plus: the boulder
 * procmodel + stone_boulder scatter load and cross-check (kind = STONE = 1).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { JsonSource } from "@voxim/content";
import type { VoxelAtom } from "@voxim/content";
import { boulderGrammar } from "./generators/boulder_grammar.ts";
import { crossCheckProcModels } from "./mod.ts";
import { bakeVoxels } from "../voxel_bake.ts";

const content = await JsonSource.load("packages/content/data");
const ctx = { resolveMaterial: (name: string) => content.materials.get(name)!.id };
const PARAMS = content.procModels.get("boulder")!.params;
const STONE = content.materials.get("stone")!.id;
const gen = (seed: number): VoxelAtom[] => boulderGrammar(seed, PARAMS, ctx);

Deno.test("T-285d: boulder + stone_boulder load and cross-check (no engine edits)", () => {
  assert(content.procModels.get("boulder"), "boulder procModel");
  const sc = content.scatter.get("stone_boulder")!;
  assertEquals(sc.kind, 1, "scatters on STONE terrain");
  assertEquals(sc.procModel, "boulder");
  assertEquals(sc.pool, 6, "6 stone variants");
  crossCheckProcModels(content); // boulder_grammar must be registered too
});

Deno.test("T-285d: deterministic + varied stone blobs", () => {
  assertEquals(gen(3), gen(3));
  const sizes = new Set([gen(1).length, gen(2).length, gen(3).length, gen(4).length]);
  assert(sizes.size >= 2, `variation across seeds, got ${[...sizes].join("/")}`);
});

Deno.test("T-285d: a solid bounded stone blob", () => {
  for (let s = 0; s < 6; s++) {
    const a = gen(s);
    assert(a.length > 4 && a.length < 1500, `seed ${s}: ${a.length} atoms bounded`);
    for (const atom of a) {
      assertEquals(atom.materialId, STONE, "all stone");
      assertEquals([atom.sx, atom.sy, atom.sz], [1, 1, 1], "unit voxels");
    }
  }
});

Deno.test("T-285d: bakes crack-free (24 verts / 36 indices per atom)", () => {
  const a = gen(11);
  const baked = bakeVoxels(a, STONE);
  assertEquals(baked.positions.length, a.length * 24 * 3);
  assertEquals(baked.indices.length, a.length * 36);
  const verts = baked.positions.length / 3;
  for (const idx of baked.indices) assert(idx < verts, "index in range");
});
