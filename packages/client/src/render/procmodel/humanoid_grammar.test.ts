/**
 * humanoid_grammar (T-302) — the first `class:"character"` generator. Pins:
 * the `human` procModel loads and cross-checks, the registered flat generator
 * is deterministic + ground-anchored + bakes crack-free, and the per-bone
 * entry point (`humanoidGrammarByBone`, the mesh-build/hitbox consumer shape)
 * agrees with the flat generator on total atom count — one evaluator behind
 * both shapes, not two.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { JsonSource } from "@voxim/content";
import type { VoxelAtom } from "@voxim/content";
import { humanoidGrammar, humanoidGrammarByBone } from "./generators/humanoid_grammar.ts";
import { crossCheckProcModels } from "./mod.ts";
import { crossCheckDesignLanguage } from "./design_language_check.ts";
import { bakeVoxels } from "../voxel_bake.ts";

const content = await JsonSource.load("packages/content/data");
const ctx = {
  resolveMaterial: (name: string) => content.materials.get(name)!.id,
  getSkeleton: (id: string) => content.skeletons.get(id),
};
const PARAMS = content.procModels.get("human")!.params;
const SKIN = content.materials.get("skin")!.id;
const gen = (seed: number): VoxelAtom[] => humanoidGrammar(seed, PARAMS, ctx);

Deno.test("T-302: human procModel loads as class:'character' and cross-checks (generator + design-language)", () => {
  const pm = content.procModels.get("human")!;
  assertEquals(pm.generator, "humanoid_grammar");
  assertEquals(pm.class, "character");
  crossCheckProcModels(content);
  crossCheckDesignLanguage(content); // includes the ground-plane invariant
});

Deno.test("T-302: deterministic per seed (rest-pose params are seed-invariant, but the call must still be pure)", () => {
  assertEquals(gen(1), gen(1));
  assertEquals(gen(1), gen(7)); // humanoid_grammar's rest-pose flatten ignores seed today (no per-instance morph sampling here)
});

Deno.test("T-302: throws on an unknown skeleton id", () => {
  let threw = false;
  try {
    humanoidGrammar(1, { skeletonId: "no_such_skeleton" }, ctx);
  } catch {
    threw = true;
  }
  assert(threw, "unknown skeletonId should throw");
});

Deno.test("T-302: emits a non-trivial SOLID+LIMB body, all skin material, unit voxel grain", () => {
  const atoms = gen(1);
  assert(atoms.length > 50, `expected a substantial body, got ${atoms.length} atoms`);
  for (const a of atoms) {
    assertEquals(a.materialId, SKIN);
    assertEquals(a.sx, 0.09);
    assertEquals(a.sy, 0.09);
    assertEquals(a.sz, 0.09);
  }
});

Deno.test("T-302: ground-anchored — lowest voxel face sits at model-space z≈0", () => {
  const atoms = gen(1);
  let minZ = Infinity;
  for (const a of atoms) minZ = Math.min(minZ, a.cz - a.sz / 2);
  assert(Math.abs(minZ) < 0.5, `expected minZ≈0, got ${minZ}`);
});

Deno.test("T-302: bakes crack-free (24 verts / 36 indices per atom)", () => {
  const atoms = gen(1);
  const baked = bakeVoxels(atoms, SKIN);
  assertEquals(baked.positions.length, atoms.length * 24 * 3);
  assertEquals(baked.indices.length, atoms.length * 36);
});

Deno.test("T-302: humanoidGrammarByBone (per-bone, live-pose shape) covers every bone the flat generator covers, same total atom count", () => {
  const skeleton = content.skeletons.get("biped")!;
  const neutral: Record<string, number> = {};
  for (const m of skeleton.morphParams ?? []) neutral[m.id] = 1.0;
  const byBone = humanoidGrammarByBone(skeleton, neutral, ctx.resolveMaterial);
  let total = 0;
  for (const atoms of byBone.values()) total += atoms.length;
  assertEquals(total, gen(1).length, "per-bone and flat shapes voxelize the identical set of parts");
});

Deno.test("T-302: humanoidGrammarByBone returns bone-LOCAL atoms (not world-flattened)", () => {
  const skeleton = content.skeletons.get("biped")!;
  const neutral: Record<string, number> = {};
  for (const m of skeleton.morphParams ?? []) neutral[m.id] = 1.0;
  const torsoLower = humanoidGrammarByBone(skeleton, neutral, ctx.resolveMaterial).get("torso_lower")!;
  assert(torsoLower.length > 0, "torso_lower should have atoms");
  // Bone-local atoms are authored along local +Z centered on the bone origin
  // (body_recipe.ts's convention) — every torso_lower atom's cz should be
  // small (within one part's length), unlike the flat generator's world cz
  // which accumulates the whole skeleton's height.
  for (const a of torsoLower) assert(a.cz < 1, `expected bone-local cz, got ${a.cz}`);
});
