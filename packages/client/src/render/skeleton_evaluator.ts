/**
 * Skeleton pose evaluator — Three.js wrapper around evaluateAnimationLayers().
 *
 * Pipeline (called each render frame):
 *   1. evaluatePose()     — FK: CSM-driven layer stack → bone Euler rotations
 *   2. updateSkeletonPose() (entity_mesh.ts) — write Euler rotations to THREE.Groups
 *
 * The IK-driven arm post-pass is gone (T-182 step 6): swings now play
 * authored clips through the CSM combat layer, so the arms come straight
 * from the FK pass like every other body part. Two-bone IK lives in
 * `ik_solver.ts` and is still available for future static constraints
 * (foot planting, off-hand grip helper) — just no longer wired up here.
 *
 * `evaluateAnimationLayers` lives in `@voxim/content` so the server
 * (HitboxSystem) can also call it without Three.js.
 *
 * `evaluateWeaponSlice` is retained for the weapon trail ribbon — that
 * still derives tip positions from the swing path until the trail system
 * is moved to a clip-driven blade-points scheme.
 */
import * as THREE from "three";
import type { SkeletonDef, AnimationClip, BoneMask, AnimationStateData } from "@voxim/content";
import { evaluateAnimationLayers } from "@voxim/content";
import { evaluateSwingPath, deriveTip } from "@voxim/content";
import type { SwingKeyframe } from "@voxim/content";

// ---- FK pose evaluation ----

/**
 * Evaluate a full skeleton pose from an AnimationStateData layer stack.
 *
 * @returns Map from boneId to THREE.Euler (XYZ, radians).
 */
export function evaluatePose(
  skeleton: SkeletonDef | undefined,
  clipIndex: ReadonlyMap<string, AnimationClip>,
  maskIndex: ReadonlyMap<string, BoneMask>,
  animState: AnimationStateData | null,
): Map<string, THREE.Euler> {
  if (!skeleton || !animState || animState.layers.length === 0) return new Map();
  const boneRotations = evaluateAnimationLayers(skeleton, clipIndex, maskIndex, animState.layers);
  const out = new Map<string, THREE.Euler>();
  for (const [bone, rot] of boneRotations) {
    out.set(bone, new THREE.Euler(rot.x, rot.y, rot.z));
  }
  return out;
}

// ---- weapon position evaluation (used by trail rendering only) ----

/**
 * Evaluate hilt, tip, and blade direction at normalised time t in entity-local
 * Three.js space (right=X, up=Y, forward=-Z).
 */
export function evaluateWeaponSlice(
  keyframes: SwingKeyframe[],
  t: number,
  bladeLength: number,
): {
  hiltX: number; hiltY: number; hiltZ: number;
  tipX: number;  tipY: number;  tipZ: number;
  bladeDirX: number; bladeDirY: number; bladeDirZ: number;
} {
  const pose = evaluateSwingPath(keyframes, t);
  const tip = deriveTip(pose.hilt, pose.bladeDir, bladeLength);
  return {
    hiltX:  pose.hilt.right,     hiltY:  pose.hilt.up,     hiltZ: -pose.hilt.fwd,
    tipX:   tip.right,           tipY:   tip.up,           tipZ:  -tip.fwd,
    bladeDirX: pose.bladeDir.right, bladeDirY: pose.bladeDir.up, bladeDirZ: -pose.bladeDir.fwd,
  };
}
