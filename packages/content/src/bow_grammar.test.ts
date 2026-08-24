/**
 * bow_grammar (T-346 — T-306 composition) — the bow/crossbow twin of
 * blade_grammar.test.ts. Unlike blade_grammar there is no server-trace
 * parity gate to prove (bow_grammar is purely visual — see the shared
 * core's file doc), so this file instead proves the shape invariants a
 * generated bow must hold: limb symmetry, string-to-tip anchoring,
 * determinism, seed-uniqueness, crossbow/bow shape distinctness, and
 * authored-range bounds.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { JsonSource } from "../mod.ts";
import { deriveBowGeometry, bowGrammarAtoms } from "./bow_grammar.ts";
import type { BowGrammarParams } from "./bow_grammar.ts";

const content = await JsonSource.load("packages/content/data");
const BOW_PARAMS = content.procModels.get("bow_wood")!.params as BowGrammarParams;
const CROSSBOW_PARAMS = content.procModels.get("crossbow_wood")!.params as BowGrammarParams;
const resolveMaterial = (name: string) => content.materials.get(name)!.id;

/** FNV-1a — the seed derivation entity_mesh_registry.ts applies to an
 *  equipped weapon's EntityId (same helper blade_grammar.test.ts uses). */
function hash32(s: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

Deno.test("T-346: bow procModels load and name bow_grammar", () => {
  for (const id of ["bow_wood", "crossbow_wood"]) {
    const pm = content.procModels.get(id);
    assert(pm, `${id} should load`);
    assertEquals(pm!.generator, "bow_grammar");
  }
  assertEquals(BOW_PARAMS.variant, "bow");
  assertEquals(CROSSBOW_PARAMS.variant, "crossbow");
});

Deno.test("T-346: deriveBowGeometry is deterministic per seed (shared engine PRNG, no Math.random)", () => {
  assertEquals(deriveBowGeometry(12345, BOW_PARAMS), deriveBowGeometry(12345, BOW_PARAMS));
  assertEquals(deriveBowGeometry(0, BOW_PARAMS), deriveBowGeometry(0, BOW_PARAMS));
});

Deno.test("T-346: bowGrammarAtoms is a pure function of the seed (byte-identical atoms for the same seed)", () => {
  const seed = hash32("determinism-check");
  const a = bowGrammarAtoms(seed, BOW_PARAMS, resolveMaterial);
  const b = bowGrammarAtoms(seed, BOW_PARAMS, resolveMaterial);
  assertEquals(JSON.stringify(a), JSON.stringify(b), "same seed -> byte-identical atoms");
});

Deno.test("T-346: seed-unique — different seeds yield different bow geometry", () => {
  const a = deriveBowGeometry(hash32("bow-entity-A"), BOW_PARAMS);
  const b = deriveBowGeometry(hash32("bow-entity-B"), BOW_PARAMS);
  assert(
    a.limbLength !== b.limbLength || a.limbHalfWidth !== b.limbHalfWidth || a.curveOffset !== b.curveOffset,
    "distinct weapon entities must get distinct bows",
  );
});

Deno.test("T-346: param bounds — derived scalars stay within the authored ranges", () => {
  for (const seed of [0, 1, 12345, hash32("bounds-check")]) {
    for (const params of [BOW_PARAMS, CROSSBOW_PARAMS]) {
      const geo = deriveBowGeometry(seed, params);
      assert(geo.limbLength >= params.limbLengthRange[0] && geo.limbLength <= params.limbLengthRange[1], "limbLength in range");
      assert(
        geo.limbHalfWidth >= params.limbHalfWidthRange[0] && geo.limbHalfWidth <= params.limbHalfWidthRange[1],
        "limbHalfWidth in range",
      );
      assert(geo.curveOffset >= params.curveRange[0] && geo.curveOffset <= params.curveRange[1], "curveOffset in range");
    }
  }
});

Deno.test("T-346: limb symmetry — the two limbs are mirror images (same |curvePerp| profile, opposite sign of the mount-axis coordinate)", () => {
  const seed = hash32("symmetry-check");
  const atoms = bowGrammarAtoms(seed, BOW_PARAMS, resolveMaterial);
  const limbMat = resolveMaterial(BOW_PARAMS.materials.limb);
  const limbAtoms = atoms.filter((a) => a.materialId === limbMat);
  assert(limbAtoms.length > 0, "limb atoms present");
  // "bow" variant: limb axis is z, curve axis is x. Every positive-z limb
  // atom must have a mirror atom at -z with the SAME x offset (both limbs
  // bulge the SAME absolute direction — a recurve silhouette symmetric
  // about the riser).
  const byAbsZ = new Map<string, number[]>();
  for (const a of limbAtoms) {
    const key = Math.abs(a.cz).toFixed(3);
    const list = byAbsZ.get(key) ?? [];
    list.push(a.cx);
    byAbsZ.set(key, list);
  }
  for (const [, xs] of byAbsZ) {
    assertEquals(xs.length, 2, "each |z| offset has exactly two limb atoms (upper + lower)");
    assert(Math.abs(xs[0] - xs[1]) < 1e-9, "both limbs bulge to the same x offset at mirrored z");
  }
});

Deno.test("T-346: string endpoints are anchored to the resolved limb tips", () => {
  const seed = hash32("string-anchor-check");
  const geo = deriveBowGeometry(seed, BOW_PARAMS);
  const atoms = bowGrammarAtoms(seed, BOW_PARAMS, resolveMaterial);
  const stringMat = resolveMaterial(BOW_PARAMS.materials.string);
  const stringAtoms = atoms.filter((a) => a.materialId === stringMat);
  assert(stringAtoms.length >= 2, "string emits at least two atoms (endpoints)");

  // "bow": limb tips sit at z = ±(riserLength/2 + limbLength), x = 0 (the
  // sine curve returns to the centerline at t=1). The string is pulled back
  // along -y by stringOffset, so its extreme-z atoms must sit at the tip z
  // (within one voxel step) and at cy = -stringOffset.
  const expectedTipZ = BOW_PARAMS.riserLength / 2 + geo.limbLength;
  let minZ = Infinity, maxZ = -Infinity;
  for (const a of stringAtoms) { minZ = Math.min(minZ, a.cz); maxZ = Math.max(maxZ, a.cz); }
  const vs = BOW_PARAMS.voxelSize;
  assert(Math.abs(maxZ - expectedTipZ) <= vs, `string's +z endpoint (${maxZ}) anchors to the upper limb tip (${expectedTipZ})`);
  assert(Math.abs(minZ - (-expectedTipZ)) <= vs, `string's -z endpoint (${minZ}) anchors to the lower limb tip (${-expectedTipZ})`);
  for (const a of stringAtoms) {
    assertEquals(a.cy, -BOW_PARAMS.stringOffset, "every string atom is pulled back by exactly stringOffset");
  }
});

Deno.test("T-346: crossbow shape is distinct from bow — perpendicular limb axis, a stock, and a mechanism block", () => {
  const seed = hash32("shape-distinctness");
  const bowAtoms = bowGrammarAtoms(seed, BOW_PARAMS, resolveMaterial);
  const crossbowAtoms = bowGrammarAtoms(seed, CROSSBOW_PARAMS, resolveMaterial);
  const bowLimbMat = resolveMaterial(BOW_PARAMS.materials.limb);
  const crossbowLimbMat = resolveMaterial(CROSSBOW_PARAMS.materials.limb);

  // bow limbs vary in z (vertical), essentially flat in x at the tip; crossbow
  // limbs (the prod) vary in x (horizontal) instead — the limb spread swaps axes.
  const bowLimb = bowAtoms.filter((a) => a.materialId === bowLimbMat);
  const crossbowLimb = crossbowAtoms.filter((a) => a.materialId === crossbowLimbMat);
  const bowZSpread = Math.max(...bowLimb.map((a) => Math.abs(a.cz)));
  const bowXBulge = Math.max(...bowLimb.map((a) => Math.abs(a.cx))); // the recurve bulge, not a spread axis
  const crossbowXSpread = Math.max(...crossbowLimb.map((a) => Math.abs(a.cx)));
  assert(bowZSpread > bowXBulge, "bow limbs primarily extend along z, not x");
  assert(crossbowXSpread > 0, "crossbow limbs (the prod) extend along x");

  // Only the crossbow emits a distinct mechanism-material block (materials.mechanism).
  const mechMat = resolveMaterial(CROSSBOW_PARAMS.materials.mechanism!);
  assert(crossbowAtoms.some((a) => a.materialId === mechMat), "crossbow emits a mechanism block");
  assert(!bowAtoms.some((a) => a.materialId === mechMat), "bow variant never emits the crossbow mechanism material");

  // Different atom counts / total footprint — the two variants are not the same shape reskinned.
  assert(bowAtoms.length !== crossbowAtoms.length || bowZSpread !== crossbowXSpread, "bow and crossbow produce visibly different geometry");
});

Deno.test("T-346: LIMB + SOLID + string composition — all material roles present for both variants", () => {
  for (const params of [BOW_PARAMS, CROSSBOW_PARAMS]) {
    const seed = hash32("composition-" + params.variant);
    const atoms = bowGrammarAtoms(seed, params, resolveMaterial);
    const mats = new Set(atoms.map((a) => a.materialId));
    assert(mats.has(resolveMaterial(params.materials.limb)), `${params.variant}: LIMB present`);
    assert(mats.has(resolveMaterial(params.materials.riser)), `${params.variant}: SOLID riser/stock present`);
    assert(mats.has(resolveMaterial(params.materials.string)), `${params.variant}: string present`);
  }
});
