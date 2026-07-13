import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import {
  applyFootTerrainIK,
  applyLocomotionPose,
  applyLookAtPose,
} from "./swing_pose.ts";
import { solveSkeleton } from "./skeleton_solver.ts";
import { eulerFromQuat, quatFromEulerXYZ } from "./ik_solver.ts";
import type { BoneDef, SkeletonDef } from "./types.ts";

/**
 * T-308/T-186: coverage for the base-pose-catalogue producers that landed
 * without any prior tests in this file (locomotion lean, foot-terrain IK,
 * head/gaze stabilization). A minimal synthetic biped — legs + torso/head,
 * no arms — is enough; magnitudes are made up (unlike biped.json's authored
 * proportions) but internally consistent, matching body_recipe.test.ts's/
 * hitbox_derive.test.ts's synthetic-skeleton convention for pure-math tests.
 */
function makeSkeleton(): SkeletonDef {
  return {
    id: "test_biped",
    archetype: "biped",
    bones: [
      { id: "root", parent: null, restX: 0, restY: 0, restZ: 0 },
      { id: "torso_lower", parent: "root", restX: 0, restY: 0, restZ: 1.0 },
      { id: "torso_mid", parent: "torso_lower", restX: 0, restY: 0, restZ: 0.3 },
      { id: "torso_upper", parent: "torso_mid", restX: 0, restY: 0, restZ: 0.3 },
      { id: "head", parent: "torso_upper", restX: 0, restY: 0, restZ: 0.2 },
      { id: "upper_leg_l", parent: "torso_lower", restX: 0.2, restY: 0, restZ: -0.1 },
      { id: "lower_leg_l", parent: "upper_leg_l", restX: 0, restY: 0, restZ: -0.5 },
      { id: "foot_l", parent: "lower_leg_l", restX: 0, restY: 0, restZ: -0.5 },
      { id: "upper_leg_r", parent: "torso_lower", restX: -0.2, restY: 0, restZ: -0.1 },
      { id: "lower_leg_r", parent: "upper_leg_r", restX: 0, restY: 0, restZ: -0.5 },
      { id: "foot_r", parent: "lower_leg_r", restX: 0, restY: 0, restZ: -0.5 },
    ],
  };
}

function boneIndex(skeleton: SkeletonDef): Map<string, BoneDef> {
  return new Map(skeleton.bones.map((b) => [b.id, b]));
}

// ---- applyFootTerrainIK ----

Deno.test("applyFootTerrainIK: flat terrain under root and both feet is a no-op", () => {
  const skeleton = makeSkeleton();
  const idx = boneIndex(skeleton);
  const base = new Map();
  const out = applyFootTerrainIK(skeleton, idx, base, 1, { x: 0, y: 0 }, 0, () => 5);
  assertEquals(out.size, 0);
});

Deno.test("applyFootTerrainIK: a foot over higher ground is planted higher (up to the clamp)", () => {
  const skeleton = makeSkeleton();
  const idx = boneIndex(skeleton);
  const base = new Map();
  // facing = 0 → forward=(cos0,sin0)=(1,0), right=(sin0,-cos0)=(0,-1); the left
  // foot (local right=+0.2) sits at world y = root.y - 0.2*right... use a height
  // field that only depends on world Y so the exact axis mapping doesn't matter,
  // just that SOME foot ends up over the raised strip.
  const heightAt = (_wx: number, wy: number) => (wy > 0.05 ? 5 + 10 : 5);
  const out = applyFootTerrainIK(skeleton, idx, base, 1, { x: 0, y: 0 }, 0, heightAt, { maxOffset: 0.3 });
  assert(out.size > 0, "expected at least one leg bone to be re-aimed");

  const P0 = solveSkeleton(skeleton, idx, base, 1);
  const P1 = solveSkeleton(skeleton, idx, out, 1);
  const restFootY = P0.get("foot_l")!.pos.y;
  const rows: number[] = [];
  for (const foot of ["foot_l", "foot_r"]) {
    rows.push(P1.get(foot)!.pos.y - restFootY);
  }
  // At least one foot must have moved, and none may have moved further than
  // the clamp (0.3 world units at scale 1).
  assert(rows.some((dy) => Math.abs(dy) > 1e-3), "expected a foot to move");
  for (const dy of rows) assert(Math.abs(dy) <= 0.3 + 1e-6, `dy ${dy} exceeded clamp`);
});

Deno.test("applyFootTerrainIK: an extreme height delta clamps instead of hyper-extending", () => {
  const skeleton = makeSkeleton();
  const idx = boneIndex(skeleton);
  const base = new Map();
  // Root ground = 0; every foot XZ probes into a 1000-unit cliff (e.g. the
  // unloaded-chunk-returns-0 artifact this producer is documented to guard
  // against).
  const heightAt = () => 1000;
  const out = applyFootTerrainIK(skeleton, idx, base, 1, { x: 0, y: 0 }, 0, heightAt, { maxOffset: 0.4 });
  const P0 = solveSkeleton(skeleton, idx, base, 1);
  const P1 = solveSkeleton(skeleton, idx, out, 1);
  for (const foot of ["foot_l", "foot_r"]) {
    const dy = P1.get(foot)!.pos.y - P0.get(foot)!.pos.y;
    assert(dy <= 0.4 + 1e-6, `foot ${foot} moved ${dy}, past the 0.4 clamp`);
  }
});

// ---- applyLookAtPose ----

Deno.test("applyLookAtPose: gain 0 is a no-op", () => {
  const skeleton = makeSkeleton();
  const idx = boneIndex(skeleton);
  const base = new Map([["torso_lower", eulerFromQuat(quatFromEulerXYZ(0, 0, 0.4))]]);
  const out = applyLookAtPose(skeleton, idx, base, 1, 0);
  assertEquals(out.get("head"), undefined);
});

Deno.test("applyLookAtPose: gain 1 fully cancels an upstream spine lean on the head", () => {
  const skeleton = makeSkeleton();
  const idx = boneIndex(skeleton);
  // A hard roll on torso_lower, as if a strafe/back-pedal lean had already run.
  const base = new Map([["torso_lower", eulerFromQuat(quatFromEulerXYZ(0, 0, 0.5))]]);
  const out = applyLookAtPose(skeleton, idx, base, 1, 1);
  const P = solveSkeleton(skeleton, idx, out, 1);
  const REST = solveSkeleton(skeleton, idx, new Map(), 1);
  const cur = P.get("head")!.rot, rest = REST.get("head")!.rot;
  assertAlmostEquals(cur.x, rest.x, 1e-6);
  assertAlmostEquals(cur.y, rest.y, 1e-6);
  assertAlmostEquals(cur.z, rest.z, 1e-6);
  assertAlmostEquals(cur.w, rest.w, 1e-6);
});

Deno.test("applyLookAtPose: partial gain lands strictly between the leaned and level head", () => {
  const skeleton = makeSkeleton();
  const idx = boneIndex(skeleton);
  const base = new Map([["torso_lower", eulerFromQuat(quatFromEulerXYZ(0, 0, 0.5))]]);
  const leaned = solveSkeleton(skeleton, idx, base, 1).get("head")!.rot;
  const rest = solveSkeleton(skeleton, idx, new Map(), 1).get("head")!.rot;
  const out = applyLookAtPose(skeleton, idx, base, 1, 0.5);
  const half = solveSkeleton(skeleton, idx, out, 1).get("head")!.rot;
  // half should differ from BOTH endpoints (not clamped to either extreme).
  const distTo = (a: typeof half, b: typeof half) =>
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w);
  assert(distTo(half, leaned) > 1e-4);
  assert(distTo(half, rest) > 1e-4);
});

// ---- applyLocomotionPose: facing-relative back-pedal lean (T-308/T-328) ----

Deno.test("applyLocomotionPose: strafe/turn/moveFwd all zero is a no-op", () => {
  const skeleton = makeSkeleton();
  const idx = boneIndex(skeleton);
  const out = applyLocomotionPose(skeleton, idx, new Map(), 1, { strafe: 0, turn: 0, moveFwd: 0 });
  assertEquals(out.size, 0);
});

Deno.test("applyLocomotionPose: moving backward (moveFwd=-1) folds the spine back", () => {
  const skeleton = makeSkeleton();
  const idx = boneIndex(skeleton);
  const out = applyLocomotionPose(skeleton, idx, new Map(), 1, { moveFwd: -1 });
  assert(out.size > 0, "expected spine bones to be overridden");
  const rest = solveSkeleton(skeleton, idx, new Map(), 1).get("torso_upper")!.rot;
  const leaned = solveSkeleton(skeleton, idx, out, 1).get("torso_upper")!.rot;
  assert(
    Math.abs(leaned.x - rest.x) > 1e-4 || Math.abs(leaned.y - rest.y) > 1e-4,
    "expected the back-pedal lean to actually rotate the upper torso",
  );
});

Deno.test("applyLocomotionPose: moving forward (moveFwd=+1) alone adds no lean (clips already carry it)", () => {
  const skeleton = makeSkeleton();
  const idx = boneIndex(skeleton);
  const out = applyLocomotionPose(skeleton, idx, new Map(), 1, { moveFwd: 1, strafe: 0, turn: 0 });
  assertEquals(out.size, 0);
});
