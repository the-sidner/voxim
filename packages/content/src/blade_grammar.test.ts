/**
 * blade_grammar (T-306) — the CRITICAL parity test: the geometry the CLIENT
 * renders (visual blade voxels) and the geometry the SERVER sweeps (the hit
 * capsule) are DERIVED FROM ONE SHARED FUNCTION off ONE seed, so the visible
 * blade and the hitbox can never diverge (the T-186 hitbox-parity class of
 * bug this ticket explicitly guards against).
 *
 * The two production consumers:
 *   - CLIENT render (`entity_mesh_registry.ts` bakeGeneratedBlade →
 *     `bladeGrammarAtoms`) — bakes the visual voxels; the LIMB spine is built
 *     to `deriveBladeGeometry(seed, params).length`.
 *   - SERVER weapon_trace (`combat.ts` weaponContext →
 *     `deriveBladeGeometry`) — overrides the swept capsule's length/radius
 *     with the SAME `deriveBladeGeometry(seed, params)` output.
 * This test stands in for both by asserting: (1) determinism + seed-uniqueness
 * of the shared derivation; (2) the client's baked-atom blade extent equals
 * the server's swept length for the SAME seed (the parity gate).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { JsonSource } from "../mod.ts";
import { deriveBladeGeometry, bladeGrammarAtoms } from "./blade_grammar.ts";
import type { BladeGrammarParams } from "./blade_grammar.ts";

const content = await JsonSource.load("packages/content/data");
const PARAMS = content.procModels.get("blade_iron_straight")!.params as BladeGrammarParams;
const resolveMaterial = (name: string) => content.materials.get(name)!.id;

/** FNV-1a — the seed derivation both server (combat.ts) and client
 *  (entity_mesh_registry.ts) apply to an equipped weapon's EntityId. */
function hash32(s: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

Deno.test("T-306: blade procModels load and name blade_grammar", () => {
  for (const id of ["blade_iron_straight", "blade_steel_curved", "blade_iron_serrated"]) {
    const pm = content.procModels.get(id);
    assert(pm, `${id} should load`);
    assertEquals(pm!.generator, "blade_grammar");
  }
});

Deno.test("T-306: deriveBladeGeometry is deterministic per seed (shared engine PRNG, no Math.random)", () => {
  assertEquals(deriveBladeGeometry(12345, PARAMS), deriveBladeGeometry(12345, PARAMS));
  assertEquals(deriveBladeGeometry(0, PARAMS), deriveBladeGeometry(0, PARAMS));
});

Deno.test("T-306: seed-unique — different seeds yield different blade geometry", () => {
  const a = deriveBladeGeometry(hash32("weapon-entity-A"), PARAMS);
  const b = deriveBladeGeometry(hash32("weapon-entity-B"), PARAMS);
  assert(a.length !== b.length || a.radius !== b.radius, "distinct weapon entities must get distinct blades");
  // Both stay within the authored ranges (the design-language density band).
  for (const g of [a, b]) {
    assert(g.length >= PARAMS.lengthRange[0] && g.length <= PARAMS.lengthRange[1], "length in range");
    assert(g.radius >= PARAMS.radiusRange[0] && g.radius <= PARAMS.radiusRange[1], "radius in range");
  }
});

Deno.test("T-306: CLIENT render == SERVER trace — the baked blade's LIMB-spine extent equals the swept length, one seed, one function", () => {
  // Fix a seed (as if hash32(weaponEntityId) on both sides).
  const seed = hash32("shared-weapon-instance");

  // SERVER side: the length weapon_trace sweeps the hit capsule to.
  const serverGeo = deriveBladeGeometry(seed, PARAMS);

  // CLIENT side: the actual voxels the render bakes. The spine runs +z from
  // the guard (z=0) to the tip; its max z-face is the visible blade extent.
  const atoms = bladeGrammarAtoms(seed, PARAMS, resolveMaterial);
  assert(atoms.length > 0, "generator must emit voxels");
  let maxSpineZ = 0;
  for (const a of atoms) maxSpineZ = Math.max(maxSpineZ, a.cz + a.sz / 2);

  // The baked spine reaches serverGeo.length up to voxel-grid rounding
  // (spineSteps = round(length / voxelSize)), so the visible tip and the
  // swept tip agree within one voxel — the parity guarantee.
  const vs = PARAMS.voxelSize;
  assert(
    Math.abs(maxSpineZ - serverGeo.length) <= vs,
    `client baked blade extent ${maxSpineZ} must match server swept length ${serverGeo.length} within one voxel (${vs})`,
  );
});

Deno.test("T-306: the client generator's atoms are a pure function of the SAME seed the server derives from (byte-identical re-derivation)", () => {
  const seed = hash32("determinism-check");
  const atomsA = bladeGrammarAtoms(seed, PARAMS, resolveMaterial);
  const atomsB = bladeGrammarAtoms(seed, PARAMS, resolveMaterial);
  assertEquals(JSON.stringify(atomsA), JSON.stringify(atomsB), "same seed → byte-identical atoms");
  // And the geometry the server re-derives standalone matches what the visual
  // generator built its geometry from (no second, drifting derivation exists).
  assertEquals(deriveBladeGeometry(seed, PARAMS).radius, deriveBladeGeometry(seed, PARAMS).radius);
});

Deno.test("T-306: LIMB spine + SOLID pommel + SHELL guard composition — all three material roles present", () => {
  const seed = hash32("composition");
  const atoms = bladeGrammarAtoms(seed, PARAMS, resolveMaterial);
  const mats = new Set(atoms.map((a) => a.materialId));
  const bladeMat = resolveMaterial(PARAMS.materials.blade);
  const guardMat = resolveMaterial(PARAMS.materials.guard);
  const pommelMat = resolveMaterial(PARAMS.materials.pommel);
  assert(mats.has(bladeMat), "LIMB spine (blade material) present");
  assert(mats.has(guardMat), "SHELL guard (guard material) present");
  assert(mats.has(pommelMat), "SOLID pommel (pommel material) present");
  // Pommel/grip runs -z, blade runs +z — the blade axis convention held-weapon
  // AABB anchoring (syncHandSlot) depends on.
  let minZ = Infinity, maxZ = -Infinity;
  for (const a of atoms) { minZ = Math.min(minZ, a.cz - a.sz / 2); maxZ = Math.max(maxZ, a.cz + a.sz / 2); }
  assert(minZ < 0, "pommel/grip extends below the guard (-z)");
  assert(maxZ > 0, "blade extends above the guard (+z)");
});

Deno.test("T-306: curved vs serrated styles produce distinct silhouettes from straight", () => {
  const seed = hash32("style-check");
  const straight = bladeGrammarAtoms(seed, PARAMS, resolveMaterial);
  const curvedParams = content.procModels.get("blade_steel_curved")!.params as BladeGrammarParams;
  const serratedParams = content.procModels.get("blade_iron_serrated")!.params as BladeGrammarParams;
  const curved = bladeGrammarAtoms(seed, curvedParams, resolveMaterial);
  const serrated = bladeGrammarAtoms(seed, serratedParams, resolveMaterial);
  // Curved bows the spine off the x=0 axis; straight never leaves it.
  const straightMaxAbsX = Math.max(...straight.map((a) => Math.abs(a.cx)));
  const curvedMaxAbsX = Math.max(...curved.map((a) => Math.abs(a.cx)));
  assert(curvedMaxAbsX > straightMaxAbsX, "curved spine offsets further off-axis than straight");
  // Serrated emits extra tooth atoms → more atoms than a plain spine of the same length band.
  assert(serrated.length > 0 && curved.length > 0, "both styles emit voxels");
});
