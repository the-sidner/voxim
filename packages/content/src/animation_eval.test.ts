/**
 * evaluateAnimationLayers / sampleTrack hot-path tests (T-361):
 *
 *   1. Correctness — the `out`-reuse path produces identical rotations to the
 *      allocate-fresh path, across additive / full-override / partial-override
 *      blends and masked layers.
 *   2. Allocation pin — the zero-alloc contract is asserted through object
 *      IDENTITY: repeated calls with the same `out` map return the SAME map
 *      and the SAME per-bone rotation objects (no new object per bone per
 *      frame — the client's per-entity-per-frame Map+object churn the audit
 *      flagged). `sampleTrack(_, _, out)` likewise returns `out` itself.
 *
 * Synthetic minimal skeleton, matching swing_pose.test.ts's convention.
 */
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import { evaluateAnimationLayers, sampleTrack } from "./animation_eval.ts";
import type { BoneRotation } from "./ik_solver.ts";
import type { AnimationClip, AnimationLayer, BoneMask, SkeletonDef } from "./types.ts";

function makeSkeleton(): SkeletonDef {
  return {
    id: "test_rig",
    archetype: "biped",
    bones: [
      { id: "root", parent: null, restX: 0, restY: 0, restZ: 0, restRotY: Math.PI },
      { id: "arm", parent: "root", restX: 0.5, restY: 0, restZ: 1 },
      { id: "leg", parent: "root", restX: -0.5, restY: 0, restZ: -1 },
    ],
  };
}

const CLIPS: ReadonlyMap<string, AnimationClip> = new Map<string, AnimationClip>([
  ["wave", {
    id: "wave",
    loop: true,
    tracks: {
      arm: [
        { time: 0, rotX: 0, rotY: 0, rotZ: 0 },
        { time: 1, rotX: 1, rotY: 0.5, rotZ: -0.25 },
      ],
    },
  }],
  ["kick", {
    id: "kick",
    loop: true,
    tracks: {
      arm: [{ time: 0, rotX: 0.2, rotY: 0, rotZ: 0 }],
      leg: [{ time: 0, rotX: -0.8, rotY: 0, rotZ: 0.1 }],
    },
  }],
]);

const MASKS: ReadonlyMap<string, BoneMask> = new Map<string, BoneMask>([
  ["arms_only", { id: "arms_only", boneIds: ["arm"] }],
]);

const LAYERS: readonly AnimationLayer[] = [
  { clipId: "kick", maskId: "", time: 0.5, weight: 1, blend: "override", speedScale: 1 },
  { clipId: "wave", maskId: "arms_only", time: 0.5, weight: 0.6, blend: "override", speedScale: 1 },
  { clipId: "wave", maskId: "arms_only", time: 0.25, weight: 0.3, blend: "additive", speedScale: 1 },
];

function assertPosesEqual(a: ReadonlyMap<string, BoneRotation>, b: ReadonlyMap<string, BoneRotation>) {
  assertEquals(a.size, b.size);
  for (const [bone, ra] of a) {
    const rb = b.get(bone)!;
    assertAlmostEquals(ra.x, rb.x, 1e-12, `${bone}.x`);
    assertAlmostEquals(ra.y, rb.y, 1e-12, `${bone}.y`);
    assertAlmostEquals(ra.z, rb.z, 1e-12, `${bone}.z`);
  }
}

Deno.test("out-reuse path produces the identical pose to the allocate-fresh path", () => {
  const skeleton = makeSkeleton();
  const fresh = evaluateAnimationLayers(skeleton, CLIPS, MASKS, LAYERS);
  const scratch = new Map<string, BoneRotation>();
  // Two passes through the scratch map (second reuses the first's entries).
  evaluateAnimationLayers(skeleton, CLIPS, MASKS, LAYERS, scratch);
  const reused = evaluateAnimationLayers(skeleton, CLIPS, MASKS, LAYERS, scratch);
  assertPosesEqual(fresh, reused);
  // Sanity: layers actually did something beyond rest.
  assert(fresh.get("leg")!.x !== 0, "kick must have posed the leg");
  assertAlmostEquals(fresh.get("root")!.y, Math.PI, 1e-12, "unanimated root keeps its rest (bind) rotation");
});

Deno.test("zero-alloc contract: repeated out-calls return the same map AND the same per-bone rotation objects", () => {
  const skeleton = makeSkeleton();
  const scratch = new Map<string, BoneRotation>();
  const r1 = evaluateAnimationLayers(skeleton, CLIPS, MASKS, LAYERS, scratch);
  assert(r1 === scratch, "the out map itself is returned");

  // Capture entry identities, then run many more frames.
  const entryRefs = new Map([...scratch].map(([k, v]) => [k, v]));
  for (let frame = 0; frame < 50; frame++) {
    const t = frame / 50;
    const layers: AnimationLayer[] = [
      { clipId: "kick", maskId: "", time: t, weight: 1, blend: "override", speedScale: 1 },
      { clipId: "wave", maskId: "arms_only", time: t, weight: 0.5, blend: "override", speedScale: 1 },
    ];
    const r = evaluateAnimationLayers(skeleton, CLIPS, MASKS, layers, scratch);
    assert(r === scratch);
    for (const [bone, rot] of r) {
      assert(rot === entryRefs.get(bone), `bone "${bone}" must reuse its rotation object (frame ${frame}) — no per-bone allocation`);
    }
  }
});

Deno.test("a reused out map from a different-sized skeleton is cleared, not blended with stale bones", () => {
  const skeleton = makeSkeleton();
  const scratch = new Map<string, BoneRotation>();
  scratch.set("ghost_bone", { x: 9, y: 9, z: 9 });
  const r = evaluateAnimationLayers(skeleton, CLIPS, MASKS, LAYERS, scratch);
  assertEquals(r.has("ghost_bone"), false, "stale keys from another skeleton must not survive");
  assertEquals(r.size, skeleton.bones.length);
});

Deno.test("sampleTrack writes into the provided out object and returns it, on every code path", () => {
  const out: BoneRotation = { x: 99, y: 99, z: 99 };
  const track = CLIPS.get("wave")!.tracks["arm"];

  assert(sampleTrack([], 0.5, out) === out);
  assertEquals(out, { x: 0, y: 0, z: 0 });

  assert(sampleTrack(track, 0, out) === out, "clamp-to-first path");
  assertEquals(out, { x: 0, y: 0, z: 0 });

  assert(sampleTrack(track, 1, out) === out, "clamp-to-last path");
  assertEquals(out, { x: 1, y: 0.5, z: -0.25 });

  const mid = sampleTrack(track, 0.5, out);
  assert(mid === out, "interpolated (slerp) path");
  assert(mid.x > 0 && mid.x < 1, "mid-sample lies between the keyframes");

  // No-out calls still allocate a fresh result (back-compat).
  const fresh = sampleTrack(track, 0.5);
  assert(fresh !== out);
  assertAlmostEquals(fresh.x, mid.x, 1e-12);
});
