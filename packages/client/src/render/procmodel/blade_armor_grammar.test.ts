/**
 * blade_grammar / armor_grammar client generators (T-306) — pins that the
 * registered generators are THIN wrappers over the shared @voxim/content
 * cores (no duplicated geometry), pass the boot cross-checks, and bake
 * crack-free. The seed→geometry parity (client render == server trace) is
 * proven in @voxim/content's blade_grammar.test.ts; this file proves the
 * client's registry-side wiring resolves and delegates to that same core.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { JsonSource, bladeGrammarAtoms, armorGrammarAtoms } from "@voxim/content";
import type { BladeGrammarParams, ArmorGrammarParams } from "@voxim/content";
import { bladeGrammar } from "./generators/blade_grammar.ts";
import { armorGrammar, armorGrammarByBone } from "./generators/armor_grammar.ts";
import { crossCheckProcModels } from "./mod.ts";
import { crossCheckDesignLanguage } from "./design_language_check.ts";
import { bakeVoxels } from "../voxel_bake.ts";

const content = await JsonSource.load("packages/content/data");
const ctx = {
  resolveMaterial: (name: string) => content.materials.get(name)!.id,
  getSkeleton: (id: string) => content.skeletons.get(id),
};

Deno.test("T-306: blade + armor procModels register and pass the boot cross-checks", () => {
  crossCheckProcModels(content);      // generator ids resolve
  crossCheckDesignLanguage(content);  // materials resolve, no signal hue on structural mass
  assertEquals(content.procModels.get("blade_iron_straight")!.generator, "blade_grammar");
  assertEquals(content.procModels.get("plate_armor_iron")!.generator, "armor_grammar");
});

Deno.test("T-306: the registered blade generator delegates to the shared core (byte-identical atoms)", () => {
  const params = content.procModels.get("blade_iron_straight")!.params as BladeGrammarParams;
  const viaRegistry = bladeGrammar(1234, params, ctx);
  const viaCore = bladeGrammarAtoms(1234, params, ctx.resolveMaterial);
  assertEquals(JSON.stringify(viaRegistry), JSON.stringify(viaCore), "registry wrapper == shared core");
  assert(viaRegistry.length > 0);
});

Deno.test("T-306: blade atoms bake crack-free (24 verts / 36 indices per atom)", () => {
  const params = content.procModels.get("blade_iron_straight")!.params as BladeGrammarParams;
  const atoms = bladeGrammar(1, params, ctx);
  const matId = atoms[0].materialId;
  const only = atoms.filter((a) => a.materialId === matId);
  const baked = bakeVoxels(atoms, matId);
  assertEquals(baked.positions.length, only.length * 24 * 3);
  assertEquals(baked.indices.length, only.length * 36);
});

Deno.test("T-306: armorGrammarByBone (live per-bone render shape) delegates to the shared core per bone", () => {
  const params = content.procModels.get("plate_armor_iron")!.params as ArmorGrammarParams & { skeletonId: string };
  const skeleton = content.skeletons.get("biped")!;
  const byBone = armorGrammarByBone(9, skeleton, params, ctx.resolveMaterial);
  assert(byBone.has("torso_upper"), "torso plate present");
  // The per-bone atoms match the shared core called directly for that bone.
  const b = skeleton.bones.find((x) => x.id === "torso_upper")!;
  const segLen = Math.sqrt(b.restX * b.restX + b.restY * b.restY + b.restZ * b.restZ);
  const viaCore = armorGrammarAtoms(9, "torso_upper", segLen, params, ctx.resolveMaterial);
  assertEquals(JSON.stringify(byBone.get("torso_upper")), JSON.stringify(viaCore));
});

Deno.test("T-306: the registered armor generator flattens per-bone plates to model space (rest-pose, for the boot/preview shape)", () => {
  const params = content.procModels.get("plate_armor_iron")!.params;
  const flat = armorGrammar(3, params, ctx);
  assert(flat.length > 0, "flat generator emits the union of every authored plate");
  // The flat generator sums every declared plate; each declared bone present on
  // the skeleton contributes its plate.
  const byBone = armorGrammarByBone(3, content.skeletons.get("biped")!, params as ArmorGrammarParams, ctx.resolveMaterial);
  let total = 0;
  for (const atoms of byBone.values()) total += atoms.length;
  assertEquals(flat.length, total, "flat == sum of per-bone plates");
});
