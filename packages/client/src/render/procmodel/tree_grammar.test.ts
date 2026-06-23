/**
 * tree_grammar generator (T-285b) — the real trunk/branch/foliage grammar.
 * Pins: deterministic per seed, distinct silhouettes across seeds, all three
 * materials present (trunk/branch wood + foliage grass), atom count bounded, and
 * the atoms bake through `bakeVoxels` into a well-formed crack-free mesh (24
 * verts / 36 indices per atom of a material — the voxel kitchen, no greedy mesh).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { JsonSource } from "@voxim/content";
import type { VoxelAtom } from "@voxim/content";
import { treeGrammar } from "./generators/tree_grammar.ts";
import { bakeVoxels } from "../voxel_bake.ts";

const content = await JsonSource.load("packages/content/data");
const ctx = { resolveMaterial: (name: string) => content.materials.get(name)!.id };
const PARAMS = content.procModels.get("oak")!.params;
const WOOD = content.materials.get("wood")!.id;
const GRASS = content.materials.get("grass")!.id;

const gen = (seed: number): VoxelAtom[] => treeGrammar(seed, PARAMS, ctx);

Deno.test("T-285b: deterministic — same seed → identical atoms", () => {
  assertEquals(gen(42), gen(42));
});

Deno.test("T-285b: distinct silhouettes across seeds (the pool will exploit this)", () => {
  const a = gen(1), b = gen(2), c = gen(3);
  const sig = (atoms: VoxelAtom[]) => `${atoms.length}:${atoms.filter((x) => x.materialId === GRASS).length}`;
  const sigs = new Set([sig(a), sig(b), sig(c)]);
  assert(sigs.size >= 2, `expected variation across seeds, got ${[...sigs].join(" / ")}`);
});

Deno.test("T-285b: trunk + branches (wood) and foliage (grass) are all present", () => {
  const atoms = gen(7);
  const wood = atoms.filter((a) => a.materialId === WOOD).length;
  const grass = atoms.filter((a) => a.materialId === GRASS).length;
  assert(wood > 8, `trunk+branches present (${wood} wood atoms)`);
  assert(grass > 10, `canopy present (${grass} grass atoms)`);
});

Deno.test("T-285b: atom count is bounded (no foliage explosion — dedup holds)", () => {
  for (let s = 0; s < 8; s++) {
    const n = gen(s).length;
    assert(n > 20 && n < 4000, `seed ${s}: ${n} atoms within sane bounds`);
  }
});

Deno.test("T-285b: atoms bake into a crack-free mesh (24 verts / 36 indices per atom)", () => {
  const atoms = gen(99);
  const woodCount = atoms.filter((a) => a.materialId === WOOD).length;
  const baked = bakeVoxels(atoms, WOOD);
  assertEquals(baked.positions.length, woodCount * 24 * 3, "24 verts per wood atom");
  assertEquals(baked.indices.length, woodCount * 36, "12 tris per wood atom");
  assertEquals(baked.normals.length, baked.positions.length, "one normal per vertex");
  // every index addresses a real vertex (no dangling triangle → no crack)
  const vertCount = baked.positions.length / 3;
  for (const idx of baked.indices) assert(idx < vertCount, "index in range");
});

Deno.test("T-285b: trunk voxels are FULL edge lengths centered on the axis", () => {
  const atoms = gen(5);
  const base = atoms.find((a) => a.cz < 1 && a.materialId === WOOD)!;
  assertEquals([base.cx, base.cy], [0, 0], "trunk on the axis");
  assert(base.sx >= 0.6 && base.sx <= 2.0, `base diameter sane (${base.sx})`);
  assertEquals(base.sz, 1, "one voxel tall per trunk level");
});
