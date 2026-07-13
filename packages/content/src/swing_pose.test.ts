import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import {
  applyFootTerrainIK,
  applyLocomotionPose,
  applyLookAtPose,
  applyGaitPose,
} from "./swing_pose.ts";
import { solveSkeleton } from "./skeleton_solver.ts";
import { eulerFromQuat, quatFromEulerXYZ } from "./ik_solver.ts";
import type { BoneDef, SkeletonDef, GaitDef } from "./types.ts";

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

/**
 * T-308 gait fixture: `makeSkeleton()` rests with the legs FULLY EXTENDED
 * (hip-to-foot distance == thigh+shin exactly — a straight marionette leg),
 * which leaves zero IK headroom: any outward gait delta would immediately
 * hit `aimLimb`'s reach clamp and silently stop being an exact placement,
 * which would make the no-footslide proof below meaningless (it would be
 * testing the clamp, not the gait math). This variant bends the knee
 * (lower_leg restRotX) at rest, matching how biped.json's real legs are
 * authored (nonzero restRotX), leaving reach headroom for the gait's target
 * deltas.
 */
function makeGaitSkeleton(): SkeletonDef {
  return {
    id: "test_biped_gait",
    archetype: "biped",
    bones: [
      { id: "root", parent: null, restX: 0, restY: 0, restZ: 0 },
      { id: "torso_lower", parent: "root", restX: 0, restY: 0, restZ: 1.0 },
      { id: "torso_mid", parent: "torso_lower", restX: 0, restY: 0, restZ: 0.3 },
      { id: "torso_upper", parent: "torso_mid", restX: 0, restY: 0, restZ: 0.3 },
      { id: "head", parent: "torso_upper", restX: 0, restY: 0, restZ: 0.2 },
      { id: "upper_leg_l", parent: "torso_lower", restX: 0.2, restY: 0, restZ: -0.1 },
      { id: "lower_leg_l", parent: "upper_leg_l", restX: 0, restY: 0, restZ: -0.5, restRotX: 1.8 },
      { id: "foot_l", parent: "lower_leg_l", restX: 0, restY: 0, restZ: -0.5 },
      { id: "upper_leg_r", parent: "torso_lower", restX: -0.2, restY: 0, restZ: -0.1 },
      { id: "lower_leg_r", parent: "upper_leg_r", restX: 0, restY: 0, restZ: -0.5, restRotX: 1.8 },
      { id: "foot_r", parent: "lower_leg_r", restX: 0, restY: 0, restZ: -0.5 },
    ],
  };
}

/**
 * A small forward key-pose track (contact / push-off / low-pass) whose
 * stance endpoints satisfy the no-footslide identity EXACTLY:
 * `halfSwing == strideLength * stanceFraction / 2` — see the derivation in
 * the test below. `backward`/`strafe` are left undefined (derived).
 */
function makeGaitDef(): GaitDef {
  const strideLength = 0.4, stanceFraction = 0.6, halfSwing = (strideLength * stanceFraction) / 2;
  return {
    id: "test_gait",
    strideLength,
    forward: [
      { phase: 0.0, fwd: halfSwing, right: 0, up: 0.0 },
      { phase: stanceFraction, fwd: -halfSwing, right: 0, up: 0.02 },
      { phase: 0.8, fwd: 0, right: 0, up: 0.08 },
      { phase: 1.0, fwd: halfSwing, right: 0, up: 0.0 },
    ],
  };
}

// ---- applyGaitPose (T-308) ----

Deno.test("applyGaitPose: idle (strafe/moveFwd both ~0) is a no-op", () => {
  const skeleton = makeGaitSkeleton();
  const idx = boneIndex(skeleton);
  const out = applyGaitPose(skeleton, idx, new Map(), 1, makeGaitDef(), 0.3, { strafe: 0, moveFwd: 0 });
  assertEquals(out.size, 0);
});

Deno.test("applyGaitPose: only touches the leg chain — upper-body bones in basePose survive untouched", () => {
  const skeleton = makeGaitSkeleton();
  const idx = boneIndex(skeleton);
  const upperBodyLean = eulerFromQuat(quatFromEulerXYZ(0, 0, 0.3));
  const base = new Map([
    ["torso_mid", upperBodyLean],
    ["torso_upper", upperBodyLean],
    ["head", upperBodyLean],
  ]);
  const out = applyGaitPose(skeleton, idx, base, 1, makeGaitDef(), 0.3, { moveFwd: 1, strafe: 0 });
  assertEquals(out.get("torso_mid"), upperBodyLean);
  assertEquals(out.get("torso_upper"), upperBodyLean);
  assertEquals(out.get("head"), upperBodyLean);
  // The legs DID get touched (otherwise this test would prove nothing).
  assert(out.has("upper_leg_l") || out.has("lower_leg_l") || out.has("foot_l"));
});

/**
 * The central T-308 claim: a planted (stance) foot does not slide in WORLD
 * space as phase advances, at ANY speed. `applyGaitPose` is a pure,
 * memoryless function of `phase` — it has no notion of elapsed time or
 * velocity — so proving the foot's world position is flat across the
 * stance interval [0, stanceFraction] for the phase VALUES sampled here
 * proves it for every real-time speed profile that could ever produce
 * those same phase values (that is the entire point of driving phase by
 * ground DISTANCE: fast or slow, a given phase corresponds to the same
 * ground-distance-travelled, so the same foot-world-position).
 *
 * World-space bookkeeping (facing = 0, so "forward" world travel is along
 * solver -z, per this file's space convention): the root translates by
 * `strideLength * phase` along the movement direction each direction test
 * uses; `worldCoord(phase) = localFootCoord(phase) ± strideLength * phase`
 * must be constant across the stance interval.
 */
Deno.test("applyGaitPose: forward walk — planted foot holds world position across the whole stance interval, any phase granularity", () => {
  const skeleton = makeGaitSkeleton();
  const idx = boneIndex(skeleton);
  const gait = makeGaitDef();
  const stanceEnd = 0.6;
  const worldZ = (phase: number): number => {
    const out = applyGaitPose(skeleton, idx, new Map(), 1, gait, phase, { moveFwd: 1, strafe: 0 });
    const foot = solveSkeleton(skeleton, idx, out, 1).get("foot_l")!.pos;
    // root moved FORWARD (solver -z) by strideLength*phase; foot's world z
    // is its root-relative z minus that same forward travel.
    return foot.z - gait.strideLength * phase;
  };
  const reference = worldZ(0);
  // Dense AND coarse phase samples across the stance window — "any speed"
  // means the property must hold whatever phase values a given real-time
  // speed happens to land on, not just a nice round schedule.
  for (const phase of [0, 0.05, 0.13, 0.2, 0.31, 0.4, 0.5, 0.6]) {
    assertAlmostEquals(worldZ(phase), reference, 1e-6, `foot slid at phase ${phase}`);
  }
});

Deno.test("applyGaitPose: backward walk (derived track) — planted foot holds world position across stance", () => {
  const skeleton = makeGaitSkeleton();
  const idx = boneIndex(skeleton);
  const gait = makeGaitDef();
  const worldZ = (phase: number): number => {
    const out = applyGaitPose(skeleton, idx, new Map(), 1, gait, phase, { moveFwd: -1, strafe: 0 });
    const foot = solveSkeleton(skeleton, idx, out, 1).get("foot_l")!.pos;
    // root moved BACKWARD (solver +z) by strideLength*phase.
    return foot.z + gait.strideLength * phase;
  };
  const reference = worldZ(0);
  for (const phase of [0, 0.1, 0.25, 0.4, 0.6]) {
    assertAlmostEquals(worldZ(phase), reference, 1e-6, `foot slid at phase ${phase}`);
  }
});

Deno.test("applyGaitPose: rightward strafe (derived track) — planted foot holds world position across stance", () => {
  const skeleton = makeGaitSkeleton();
  const idx = boneIndex(skeleton);
  const gait = makeGaitDef();
  const worldX = (phase: number): number => {
    const out = applyGaitPose(skeleton, idx, new Map(), 1, gait, phase, { moveFwd: 0, strafe: 1 });
    const foot = solveSkeleton(skeleton, idx, out, 1).get("foot_l")!.pos;
    // root moved RIGHT (solver +x, unlike z there is no axis flip) by
    // strideLength*phase.
    return foot.x + gait.strideLength * phase;
  };
  const reference = worldX(0);
  for (const phase of [0, 0.1, 0.25, 0.4, 0.6]) {
    assertAlmostEquals(worldX(phase), reference, 1e-6, `foot slid at phase ${phase}`);
  }
});

Deno.test("applyGaitPose: leftward strafe (sign-flipped derived track) — planted foot holds world position across stance", () => {
  const skeleton = makeGaitSkeleton();
  const idx = boneIndex(skeleton);
  const gait = makeGaitDef();
  const worldX = (phase: number): number => {
    const out = applyGaitPose(skeleton, idx, new Map(), 1, gait, phase, { moveFwd: 0, strafe: -1 });
    const foot = solveSkeleton(skeleton, idx, out, 1).get("foot_l")!.pos;
    // root moved LEFT (solver -x) by strideLength*phase.
    return foot.x - gait.strideLength * phase;
  };
  const reference = worldX(0);
  for (const phase of [0, 0.1, 0.25, 0.4, 0.6]) {
    assertAlmostEquals(worldX(phase), reference, 1e-6, `foot slid at phase ${phase}`);
  }
});

Deno.test("applyGaitPose: the two feet are contralateral (left/right sample the same track half a cycle apart)", () => {
  const skeleton = makeGaitSkeleton();
  const idx = boneIndex(skeleton);
  const gait = makeGaitDef();
  const out = applyGaitPose(skeleton, idx, new Map(), 1, gait, 0.2, { moveFwd: 1, strafe: 0 });
  const P = solveSkeleton(skeleton, idx, out, 1);
  const outShifted = applyGaitPose(skeleton, idx, new Map(), 1, gait, 0.7, { moveFwd: 1, strafe: 0 });
  const Pshifted = solveSkeleton(skeleton, idx, outShifted, 1);
  // foot_r at phase 0.2 (samples phase 0.7 internally) should match
  // foot_l at phase 0.7 (samples phase 0.2 for foot_r internally) — i.e.
  // swapping which raw phase we call with swaps which foot is "ahead".
  assertAlmostEquals(P.get("foot_r")!.pos.z, Pshifted.get("foot_l")!.pos.z, 1e-9);
});

Deno.test("applyGaitPose: rootOffset (crouch composition) keeps the SAME ground-anchored foot target, just reached from a dropped hip", () => {
  const skeleton = makeGaitSkeleton();
  const idx = boneIndex(skeleton);
  const gait = makeGaitDef();
  const loco = { moveFwd: 1, strafe: 0 };
  const rootOffset = { x: 0, y: -0.3, z: 0 };
  const standing = applyGaitPose(skeleton, idx, new Map(), 1, gait, 0.3, loco);
  const crouched = applyGaitPose(skeleton, idx, new Map(), 1, gait, 0.3, loco, { rootOffset });
  // The standing solve has no drop; the crouched solve is re-solved WITH
  // the SAME drop applyGaitPose used internally to aim its IK (mirroring
  // how the renderer actually composes crouch: the root translation and
  // the leg rotations travel together) — both should land the foot at the
  // identical ground-anchored spot, since `target` is always computed from
  // the offset-FREE rest pose regardless of rootOffset.
  const footStanding = solveSkeleton(skeleton, idx, standing, 1).get("foot_l")!.pos;
  const footCrouched = solveSkeleton(skeleton, idx, crouched, 1, undefined, undefined, rootOffset).get("foot_l")!.pos;
  assertAlmostEquals(footStanding.x, footCrouched.x, 1e-6);
  assertAlmostEquals(footStanding.y, footCrouched.y, 1e-6);
  assertAlmostEquals(footStanding.z, footCrouched.z, 1e-6);
});

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
