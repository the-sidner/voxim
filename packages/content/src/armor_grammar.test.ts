/**
 * armor_grammar (T-306) — SHELL plates keyed by bone. Pins: plates load,
 * generate seed-unique + deterministic bone-LOCAL atoms, key correctly by
 * bone (only authored bones produce plates), and each plate on one piece
 * varies independently (seed mixed with the boneId).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { JsonSource } from "../mod.ts";
import { armorGrammarAtoms } from "./armor_grammar.ts";
import type { ArmorGrammarParams } from "./armor_grammar.ts";

const content = await JsonSource.load("packages/content/data");
const PARAMS = content.procModels.get("plate_armor_iron")!.params as ArmorGrammarParams;
const resolveMaterial = (name: string) => content.materials.get(name)!.id;
const skeleton = content.skeletons.get("biped")!;

function segLen(boneId: string): number {
  const b = skeleton.bones.find((x) => x.id === boneId)!;
  return Math.sqrt(b.restX * b.restX + b.restY * b.restY + b.restZ * b.restZ);
}

Deno.test("T-306: plate_armor_iron loads as an armor_grammar procModel", () => {
  const pm = content.procModels.get("plate_armor_iron")!;
  assertEquals(pm.generator, "armor_grammar");
  assertEquals((pm.params as ArmorGrammarParams & { skeletonId: string }).skeletonId, "biped");
});

Deno.test("T-306: emits a SHELL plate for an authored bone, none for an unauthored one", () => {
  const torso = armorGrammarAtoms(1, "torso_upper", segLen("torso_upper"), PARAMS, resolveMaterial);
  assert(torso.length > 0, "torso_upper is authored → plate present");
  const armR = armorGrammarAtoms(1, "upper_arm_r", segLen("upper_arm_r"), PARAMS, resolveMaterial);
  assertEquals(armR.length, 0, "upper_arm_r has no plate spec → empty");
});

Deno.test("T-306: deterministic per seed, seed-unique across seeds", () => {
  const a = armorGrammarAtoms(42, "torso_upper", segLen("torso_upper"), PARAMS, resolveMaterial);
  const a2 = armorGrammarAtoms(42, "torso_upper", segLen("torso_upper"), PARAMS, resolveMaterial);
  assertEquals(JSON.stringify(a), JSON.stringify(a2), "same seed → identical plate");
  const b = armorGrammarAtoms(99, "torso_upper", segLen("torso_upper"), PARAMS, resolveMaterial);
  assert(JSON.stringify(a) !== JSON.stringify(b), "different seed → different plate");
});

Deno.test("T-306: each plate on one piece varies independently (seed mixed with boneId)", () => {
  const seed = 7;
  const torso = armorGrammarAtoms(seed, "torso_upper", segLen("torso_upper"), PARAMS, resolveMaterial);
  const legL = armorGrammarAtoms(seed, "upper_leg_l", segLen("upper_leg_l"), PARAMS, resolveMaterial);
  const legR = armorGrammarAtoms(seed, "upper_leg_r", segLen("upper_leg_r"), PARAMS, resolveMaterial);
  assert(torso.length > 0 && legL.length > 0 && legR.length > 0);
  // Left and right leg plates share one seed + one spec but distinct boneIds,
  // so their per-plate thickness/coverage jitter differs.
  assert(JSON.stringify(legL) !== JSON.stringify(legR), "left/right leg plates vary independently");
});

Deno.test("T-306: plates are bone-LOCAL (centered on the bone segment, not world-flattened)", () => {
  const atoms = armorGrammarAtoms(1, "torso_upper", segLen("torso_upper"), PARAMS, resolveMaterial);
  const L = segLen("torso_upper");
  for (const a of atoms) {
    assert(a.cz >= -0.01 && a.cz <= L + 0.01, `plate voxel z ${a.cz} within bone segment [0, ${L}]`);
  }
});

Deno.test("T-306: plates use the authored SHELL material (iron)", () => {
  const iron = resolveMaterial("iron");
  const atoms = armorGrammarAtoms(1, "torso_upper", segLen("torso_upper"), PARAMS, resolveMaterial);
  for (const a of atoms) assertEquals(a.materialId, iron);
});
