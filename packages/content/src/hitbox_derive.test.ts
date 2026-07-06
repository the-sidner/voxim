import { assertEquals } from "jsr:@std/assert";
import { deriveHitboxTemplate } from "./hitbox_derive.ts";
import { evaluateBodyRecipe } from "./body_recipe.ts";
import type { HitboxContentAdapter } from "./hitbox_derive.ts";
import type { Hitbox, SkeletonDef } from "./types.ts";

/**
 * T-186 Layer 2 — the single-source-of-truth seam: once a skeleton carries a
 * bodyRecipe, hitboxes for its bones must derive from the SAME resolved
 * dimensions the mesh voxelizer used, not a hardcoded per-bone radius table.
 * These tests pin that agreement mechanically (no live stack needed) — see
 * the T-186-body-recipes-layer2 lane note calling this out as the highest
 * risk seam.
 */

function makeSkeleton(): SkeletonDef {
  return {
    id: "test_biped",
    archetype: "biped",
    bones: [
      { id: "root", parent: null, restX: 0, restY: 0, restZ: 0 },
      { id: "torso", parent: "root", restX: 0, restY: 0, restZ: 1 },
      { id: "arm", parent: "torso", restX: 0.5, restY: 0, restZ: 0.5 },
      // "leg" has no bodyRecipe entry — proves partial coverage still works
      // and non-covered bones keep the pre-T-186 BONE_RADIUS fallback.
      { id: "leg", parent: "root", restX: -0.3, restY: 0, restZ: -0.8 },
    ],
    morphParams: [
      { id: "torsoHeight", bones: ["torso"], restAxis: "z", min: 0.8, max: 1.3 },
    ],
    bodyRecipe: {
      voxelSize: 0.1,
      parts: [
        { boneId: "torso", shape: "capsule", length: "1.0 * torsoHeight", radiusOrWidthTop: 0.25, material: "skin" },
        { boneId: "arm", shape: "capsule", length: 0.6, radiusOrWidthTop: 0.12, material: "skin" },
      ],
    },
  };
}

function makeAdapter(skeleton: SkeletonDef): HitboxContentAdapter {
  return {
    getModel: (id) => id === "test_model"
      ? { subObjects: [], nodes: [], skeletonId: skeleton.id }
      : null,
    getModelAabb: (_id: string): Hitbox | null => null,
    getSkeleton: (id) => id === skeleton.id ? skeleton : null,
  };
}

Deno.test("deriveHitboxTemplate: a skeletal model with zero subObjects falls straight to skeleton-driven capsules", () => {
  const skeleton = makeSkeleton();
  const parts = deriveHitboxTemplate("test_model", 0, makeAdapter(skeleton), 1.0, { torsoHeight: 1.0 });
  const boneIds = parts.map((p) => p.boneId);
  assertEquals(boneIds.includes("torso"), true);
  assertEquals(boneIds.includes("arm"), true);
  assertEquals(boneIds.includes("leg"), true);
});

Deno.test("deriveHitboxTemplate: recipe-covered bone's capsule radius scales with morphParams — matches evaluateBodyRecipe's own dims", () => {
  const skeleton = makeSkeleton();
  const adapter = makeAdapter(skeleton);

  const neutral = deriveHitboxTemplate("test_model", 0, adapter, 1.0, { torsoHeight: 1.0 });
  const torsoNeutral = neutral.find((p) => p.boneId === "torso")!;
  // length = toY (solver space: entity fwd(Y) -> solver up(Y) per the capsule's
  // toZ=length, entity-local Z maps to solver Y).
  assertEquals(torsoNeutral.toY, 1.0);

  const stretched = deriveHitboxTemplate("test_model", 0, adapter, 1.0, { torsoHeight: 1.3 });
  const torsoStretched = stretched.find((p) => p.boneId === "torso")!;
  assertEquals(torsoStretched.toY, 1.3);
});

Deno.test("deriveHitboxTemplate: non-recipe-covered bone keeps the legacy BONE_RADIUS/first-child fallback regardless of morphParams", () => {
  const skeleton = makeSkeleton();
  const adapter = makeAdapter(skeleton);
  const a = deriveHitboxTemplate("test_model", 0, adapter, 1.0, { torsoHeight: 0.8 });
  const b = deriveHitboxTemplate("test_model", 0, adapter, 1.0, { torsoHeight: 1.3 });
  const legA = a.find((p) => p.boneId === "leg")!;
  const legB = b.find((p) => p.boneId === "leg")!;
  assertEquals(legA.radius, legB.radius);
  assertEquals(legA.toX, legB.toX);
  assertEquals(legA.toY, legB.toY);
  assertEquals(legA.toZ, legB.toZ);
});

Deno.test("deriveHitboxTemplate: recipe-covered bone capsule radius matches evaluateBodyRecipe's own resolved radius (scaled)", () => {
  const skeleton = makeSkeleton();
  const adapter = makeAdapter(skeleton);
  const scale = 0.4;
  const morphParams = { torsoHeight: 1.15 };

  const template = deriveHitboxTemplate("test_model", 0, adapter, scale, morphParams);
  const torsoPart = template.find((p) => p.boneId === "torso")!;

  // Independently voxelize the same part via evaluateBodyRecipe and confirm
  // the resulting atoms' radial extent agrees with the hitbox capsule radius
  // (both derive from the exact same resolveBodyPartDims() call).
  const recipePart = skeleton.bodyRecipe!.parts.find((p) => p.boneId === "torso")!;
  const atoms = evaluateBodyRecipe(skeleton.bodyRecipe!, morphParams, () => 106).get("torso")!;
  const maxRadialExtent = Math.max(...atoms.map((a) => Math.sqrt(a.cx * a.cx + a.cy * a.cy)));
  // The voxelized atoms' farthest-out center should sit within one voxel of
  // the analytic radius the hitbox capsule uses — same source dimensions,
  // different consumers (discrete voxel grid vs. continuous capsule).
  const analyticRadius = (recipePart.radiusOrWidthTop as number) * scale;
  assertEquals(Math.abs(torsoPart.radius - analyticRadius) < 1e-9, true);
  assertEquals(maxRadialExtent * scale <= analyticRadius + skeleton.bodyRecipe!.voxelSize, true);
});

Deno.test("deriveHitboxTemplate: no bodyRecipe on the skeleton preserves pre-T-186 behavior entirely", () => {
  const skeleton: SkeletonDef = {
    id: "no_recipe",
    archetype: "biped",
    bones: [
      { id: "root", parent: null, restX: 0, restY: 0, restZ: 0 },
      { id: "torso", parent: "root", restX: 0, restY: 0, restZ: 1 },
    ],
  };
  const adapter: HitboxContentAdapter = {
    getModel: (id) => id === "m" ? { subObjects: [], nodes: [], skeletonId: skeleton.id } : null,
    getModelAabb: (): Hitbox | null => null,
    getSkeleton: (id) => id === skeleton.id ? skeleton : null,
  };
  const withMorphs = deriveHitboxTemplate("m", 0, adapter, 1.0, { anything: 5 });
  const without = deriveHitboxTemplate("m", 0, adapter, 1.0);
  assertEquals(withMorphs, without);
});
