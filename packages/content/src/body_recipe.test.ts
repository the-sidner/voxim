import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  evaluateBodyRecipe,
  resolveBodyPartDims,
  bodyPartCapsule,
  crossCheckBodyRecipe,
} from "./body_recipe.ts";
import type { BodyPartRecipeDef, BodyRecipeDef, SkeletonDef } from "./types.ts";

function makeSkeleton(overrides: Partial<SkeletonDef> = {}): SkeletonDef {
  return {
    id: "test_biped",
    archetype: "biped",
    bones: [
      { id: "root", parent: null, restX: 0, restY: 0, restZ: 0 },
      { id: "torso", parent: "root", restX: 0, restY: 0, restZ: 1 },
      { id: "arm", parent: "torso", restX: 0.5, restY: 0, restZ: 0.5 },
    ],
    morphParams: [
      { id: "torsoHeight", bones: ["torso"], restAxis: "z", min: 0.8, max: 1.3 },
      { id: "armWidth", bones: ["arm"], restAxis: "x", min: 0.7, max: 1.5 },
    ],
    ...overrides,
  };
}

const identityMaterial = (_name: string) => 42;

Deno.test("resolveBodyPartDims: constants pass through", () => {
  const part: BodyPartRecipeDef = {
    boneId: "torso", shape: "capsule", length: 1.5, radiusOrWidthTop: 0.3, material: "skin",
  };
  const dims = resolveBodyPartDims(part, {});
  assertEquals(dims, { length: 1.5, radiusTop: 0.3, radiusBot: 0.3 });
});

Deno.test("resolveBodyPartDims: formula fields scale with morph value", () => {
  const part: BodyPartRecipeDef = {
    boneId: "torso", shape: "capsule", length: "1.0 * torsoHeight", radiusOrWidthTop: 0.3, material: "skin",
  };
  const at08 = resolveBodyPartDims(part, { torsoHeight: 0.8 });
  const at13 = resolveBodyPartDims(part, { torsoHeight: 1.3 });
  assertEquals(at08.length, 0.8);
  assertEquals(at13.length, 1.3);
});

Deno.test("resolveBodyPartDims: tapered_box radiusBot defaults to radiusTop when absent", () => {
  const part: BodyPartRecipeDef = {
    boneId: "torso", shape: "tapered_box", length: 1, radiusOrWidthTop: 0.4, material: "skin",
  };
  const dims = resolveBodyPartDims(part, {});
  assertEquals(dims.radiusBot, 0.4);
});

Deno.test("resolveBodyPartDims: tapered_box with distinct top/bot", () => {
  const part: BodyPartRecipeDef = {
    boneId: "torso", shape: "tapered_box", length: 1,
    radiusOrWidthTop: "0.4 * torsoHeight", radiusOrWidthBot: "0.2 * torsoHeight", material: "skin",
  };
  const dims = resolveBodyPartDims(part, { torsoHeight: 1.0 });
  assertEquals(dims.radiusTop, 0.4);
  assertEquals(dims.radiusBot, 0.2);
});

Deno.test("evaluateBodyRecipe: determinism — same recipe + morphs -> same atom count and bounds", () => {
  const recipe: BodyRecipeDef = {
    voxelSize: 0.1,
    parts: [
      { boneId: "torso", shape: "capsule", length: "1.0 * torsoHeight", radiusOrWidthTop: 0.3, material: "skin" },
    ],
  };
  const a = evaluateBodyRecipe(recipe, { torsoHeight: 1.0 }, identityMaterial);
  const b = evaluateBodyRecipe(recipe, { torsoHeight: 1.0 }, identityMaterial);
  assertEquals(a.get("torso")!.length, b.get("torso")!.length);
  for (let i = 0; i < a.get("torso")!.length; i++) {
    assertEquals(a.get("torso")![i], b.get("torso")![i]);
  }
});

Deno.test("evaluateBodyRecipe: produces non-empty watertight atoms at neutral morphs", () => {
  const recipe: BodyRecipeDef = {
    voxelSize: 0.1,
    parts: [
      { boneId: "torso", shape: "capsule", length: 1.0, radiusOrWidthTop: 0.3, material: "skin" },
    ],
  };
  const atoms = evaluateBodyRecipe(recipe, {}, identityMaterial).get("torso")!;
  assertEquals(atoms.length > 0, true);
  for (const a of atoms) {
    assertEquals(a.materialId, 42);
    assertEquals(a.sx, 0.1);
  }
});

Deno.test("evaluateBodyRecipe: scaling a morph value monotonically scales atom extent along the bone axis", () => {
  const recipe: BodyRecipeDef = {
    voxelSize: 0.1,
    parts: [
      { boneId: "torso", shape: "capsule", length: "2.0 * torsoHeight", radiusOrWidthTop: 0.3, material: "skin" },
    ],
  };
  const short = evaluateBodyRecipe(recipe, { torsoHeight: 0.8 }, identityMaterial).get("torso")!;
  const long = evaluateBodyRecipe(recipe, { torsoHeight: 1.3 }, identityMaterial).get("torso")!;
  const maxCz = (atoms: typeof short) => Math.max(...atoms.map((a) => a.cz));
  assertEquals(maxCz(long) > maxCz(short), true);
});

Deno.test("evaluateBodyRecipe: multiple parts on the same bone accumulate", () => {
  const recipe: BodyRecipeDef = {
    voxelSize: 0.1,
    parts: [
      { boneId: "torso", shape: "capsule", length: 0.5, radiusOrWidthTop: 0.2, material: "skin" },
      { boneId: "torso", shape: "capsule", length: 0.5, radiusOrWidthTop: 0.2, material: "skin" },
    ],
  };
  const solo = evaluateBodyRecipe(
    { voxelSize: 0.1, parts: [recipe.parts[0]] },
    {},
    identityMaterial,
  ).get("torso")!.length;
  const both = evaluateBodyRecipe(recipe, {}, identityMaterial).get("torso")!.length;
  assertEquals(both, solo * 2);
});

Deno.test("evaluateBodyRecipe: zero/negative dims produce no atoms", () => {
  const recipe: BodyRecipeDef = {
    voxelSize: 0.1,
    parts: [
      { boneId: "torso", shape: "capsule", length: 0, radiusOrWidthTop: 0.3, material: "skin" },
    ],
  };
  const atoms = evaluateBodyRecipe(recipe, {}, identityMaterial).get("torso");
  assertEquals(atoms, undefined);
});

Deno.test("bodyPartCapsule: resolves to bone-local endpoint + radius matching the voxelizer's dims", () => {
  const part: BodyPartRecipeDef = {
    boneId: "arm", shape: "capsule", length: "1.0 * torsoHeight", radiusOrWidthTop: "0.2 * armWidth", material: "skin",
  };
  const capsule = bodyPartCapsule(part, { torsoHeight: 1.2, armWidth: 0.9 });
  assertEquals(capsule.fromX, 0);
  assertEquals(capsule.fromY, 0);
  assertEquals(capsule.fromZ, 0);
  assertEquals(capsule.toX, 0);
  assertEquals(capsule.toY, 0);
  assertEquals(capsule.toZ, 1.2);
  assertEquals(Math.abs(capsule.radius - 0.18) < 1e-9, true);
});

Deno.test("bodyPartCapsule: capsule shape is NOT circumscribed (already round)", () => {
  const part: BodyPartRecipeDef = {
    boneId: "torso", shape: "capsule", length: 1, radiusOrWidthTop: 0.3, material: "skin",
  };
  const capsule = bodyPartCapsule(part, {});
  assertEquals(capsule.radius, 0.3);
});

Deno.test("bodyPartCapsule: tapered_box is circumscribed — capsule radius covers the box's corner (T-323)", () => {
  const part: BodyPartRecipeDef = {
    boneId: "torso", shape: "tapered_box", length: 1, radiusOrWidthTop: 0.4, radiusOrWidthBot: 0.2, material: "skin",
  };
  const capsule = bodyPartCapsule(part, {});
  // Radius must equal the wider half-width * sqrt(2) — the exact corner
  // distance of the box's widest cross-section (voxelizePart's square test).
  const expected = 0.4 * Math.SQRT2;
  assertEquals(Math.abs(capsule.radius - expected) < 1e-9, true);

  // The box's widest corner (top end, half-width 0.4 on both axes) must sit
  // ON or INSIDE the capsule — i.e. within `radius` of the bone axis.
  const cornerDistance = Math.hypot(0.4, 0.4);
  assertEquals(cornerDistance <= capsule.radius + 1e-9, true);
});

Deno.test("crossCheckBodyRecipe: no bodyRecipe is a no-op", () => {
  crossCheckBodyRecipe(makeSkeleton());
});

Deno.test("crossCheckBodyRecipe: unknown bone id throws", () => {
  const skeleton = makeSkeleton({
    bodyRecipe: {
      voxelSize: 0.1,
      parts: [{ boneId: "nonexistent_bone", shape: "capsule", length: 1, radiusOrWidthTop: 0.2, material: "skin" }],
    },
  });
  assertThrows(() => crossCheckBodyRecipe(skeleton), Error, "unknown bone");
});

Deno.test("crossCheckBodyRecipe: unknown morph var in formula throws", () => {
  const skeleton = makeSkeleton({
    bodyRecipe: {
      voxelSize: 0.1,
      parts: [{ boneId: "torso", shape: "capsule", length: "1.0 * madeUpMorph", radiusOrWidthTop: 0.2, material: "skin" }],
    },
  });
  assertThrows(() => crossCheckBodyRecipe(skeleton), Error, "unknown morph");
});

Deno.test("crossCheckBodyRecipe: a formula that goes non-positive at a morph extreme throws", () => {
  const skeleton = makeSkeleton({
    bodyRecipe: {
      voxelSize: 0.1,
      // torsoHeight min is 0.8; "torsoHeight - 1.0" is negative at min.
      parts: [{ boneId: "torso", shape: "capsule", length: "torsoHeight - 1.0", radiusOrWidthTop: 0.2, material: "skin" }],
    },
  });
  assertThrows(() => crossCheckBodyRecipe(skeleton), Error, "resolves to");
});

Deno.test("crossCheckBodyRecipe: valid recipe across full morph range does not throw", () => {
  const skeleton = makeSkeleton({
    bodyRecipe: {
      voxelSize: 0.1,
      parts: [
        { boneId: "torso", shape: "tapered_box", length: "1.0 * torsoHeight", radiusOrWidthTop: "0.3 * torsoHeight", radiusOrWidthBot: 0.2, material: "skin" },
        { boneId: "arm", shape: "capsule", length: 0.5, radiusOrWidthTop: "0.2 * armWidth", material: "skin" },
      ],
    },
  });
  crossCheckBodyRecipe(skeleton);
});
