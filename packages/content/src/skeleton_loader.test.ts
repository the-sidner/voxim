/**
 * T-219 prerequisite: SkeletonDef.bones must be parent-before-child
 * ordered — the tile-server's bone-entity spawn walk (spawner.ts,
 * installSkeletonBones) resolves each bone's parent ENTITY via a
 * boneId->EntityId map built in array order, the same assumption the
 * client's entity_mesh.ts already makes silently. This locks the fail-fast
 * guard at content load.
 */
import { assertEquals, assertThrows } from "jsr:@std/assert";
import { validateSkeletonBoneOrder } from "./loader.ts";
import type { SkeletonDef } from "./types.ts";

function makeSkeleton(bones: SkeletonDef["bones"]): SkeletonDef {
  return { id: "test_skeleton", archetype: "biped", bones };
}

Deno.test("validateSkeletonBoneOrder: parent-first ordering passes", () => {
  const skeleton = makeSkeleton([
    { id: "root", parent: null, restX: 0, restY: 0, restZ: 0 },
    { id: "torso", parent: "root", restX: 0, restY: 0, restZ: 1 },
    { id: "arm", parent: "torso", restX: 0.5, restY: 0, restZ: 0.5 },
  ]);
  // No throw.
  validateSkeletonBoneOrder(skeleton);
});

Deno.test("validateSkeletonBoneOrder: a bone referencing a not-yet-defined parent throws", () => {
  const skeleton = makeSkeleton([
    { id: "root", parent: null, restX: 0, restY: 0, restZ: 0 },
    // "arm" declares "torso" as its parent before "torso" is defined.
    { id: "arm", parent: "torso", restX: 0.5, restY: 0, restZ: 0.5 },
    { id: "torso", parent: "root", restX: 0, restY: 0, restZ: 1 },
  ]);
  assertThrows(
    () => validateSkeletonBoneOrder(skeleton),
    Error,
    "declares parent 'torso' before it is defined",
  );
});

Deno.test("validateSkeletonBoneOrder: a single root bone (parent: null) passes", () => {
  const skeleton = makeSkeleton([
    { id: "root", parent: null, restX: 0, restY: 0, restZ: 0 },
  ]);
  validateSkeletonBoneOrder(skeleton);
});

Deno.test("validateSkeletonBoneOrder: real biped/wolf skeleton shapes pass (regression pin)", () => {
  // Mirrors data/skeletons/biped.json's bone order.
  const biped = makeSkeleton([
    { id: "root", parent: null, restX: 0, restY: 0, restZ: 0 },
    { id: "torso_lower", parent: "root", restX: 0, restY: 0, restZ: 0 },
    { id: "torso_mid", parent: "torso_lower", restX: 0, restY: 0, restZ: 0 },
    { id: "torso_upper", parent: "torso_mid", restX: 0, restY: 0, restZ: 0 },
    { id: "head", parent: "torso_upper", restX: 0, restY: 0, restZ: 0 },
    { id: "upper_arm_l", parent: "torso_upper", restX: 0, restY: 0, restZ: 0 },
    { id: "lower_arm_l", parent: "upper_arm_l", restX: 0, restY: 0, restZ: 0 },
    { id: "hand_l", parent: "lower_arm_l", restX: 0, restY: 0, restZ: 0 },
    { id: "upper_arm_r", parent: "torso_upper", restX: 0, restY: 0, restZ: 0 },
    { id: "lower_arm_r", parent: "upper_arm_r", restX: 0, restY: 0, restZ: 0 },
    { id: "hand_r", parent: "lower_arm_r", restX: 0, restY: 0, restZ: 0 },
    { id: "upper_leg_l", parent: "torso_lower", restX: 0, restY: 0, restZ: 0 },
    { id: "lower_leg_l", parent: "upper_leg_l", restX: 0, restY: 0, restZ: 0 },
    { id: "foot_l", parent: "lower_leg_l", restX: 0, restY: 0, restZ: 0 },
    { id: "upper_leg_r", parent: "torso_lower", restX: 0, restY: 0, restZ: 0 },
    { id: "lower_leg_r", parent: "upper_leg_r", restX: 0, restY: 0, restZ: 0 },
    { id: "foot_r", parent: "lower_leg_r", restX: 0, restY: 0, restZ: 0 },
  ]);
  assertEquals(biped.bones.length, 17);
  validateSkeletonBoneOrder(biped);
});
