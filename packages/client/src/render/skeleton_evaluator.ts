/**
 * Skeleton pose evaluator — thin Three.js wrapper around evaluateAnimationLayers().
 *
 * evaluateAnimationLayers() lives in @voxim/content so the server (HitboxSystem)
 * can also call it without Three.js.  This file converts BoneRotation
 * (plain {x,y,z} Euler XYZ) → THREE.Euler so the renderer can use them.
 */
import * as THREE from "three";
import type { SkeletonDef, AnimationClip, BoneMask, AnimationStateData } from "@voxim/content";
import { evaluateAnimationLayers } from "@voxim/content";
import { evaluateSwingPath, deriveTip } from "@voxim/content";
import type { SwingKeyframe } from "@voxim/content";

// ---- public API ----

/**
 * Evaluate a full skeleton pose from an AnimationStateData layer stack.
 *
 * @param skeleton   The entity's skeleton definition. Pass undefined for a no-skeleton entity.
 * @param clipIndex  Pre-built clip map from ContentCache.getClipIndex(skeletonId).
 * @param maskIndex  Pre-built mask map from ContentCache.getMaskIndex(skeletonId).
 * @param animState  The current AnimationStateData (layers + weaponActionId).
 * @returns          Map from boneId to THREE.Euler (XYZ, radians).
 */
export function evaluatePose(
  skeleton: SkeletonDef | undefined,
  clipIndex: ReadonlyMap<string, AnimationClip>,
  maskIndex: ReadonlyMap<string, BoneMask>,
  animState: AnimationStateData | null,
): Map<string, THREE.Euler> {
  if (!skeleton || !animState) return new Map();

  const layers = animState.layers;
  if (layers.length === 0) return new Map();

  const boneRotations = evaluateAnimationLayers(skeleton, clipIndex, maskIndex, layers);
  return toThreeEulerMap(boneRotations);
}

/** Convert a BoneRotation map (plain Euler XYZ) to THREE.Euler. */
function toThreeEulerMap(
  input: Map<string, { x: number; y: number; z: number }>,
): Map<string, THREE.Euler> {
  const out = new Map<string, THREE.Euler>();
  for (const [bone, rot] of input) {
    out.set(bone, new THREE.Euler(rot.x, rot.y, rot.z));
  }
  return out;
}

// ---- weapon position evaluation (used by trail + hit detection) ----

/**
 * Evaluate the weapon tip position at normalised time t in entity-local Three.js space.
 *
 * Entity-local (fwd, right, up) → Three.js local:
 *   threeX = right
 *   threeY = up
 *   threeZ = -fwd
 */
export function evaluateWeaponTip(
  keyframes: SwingKeyframe[],
  t: number,
  bladeLength: number,
): { threeX: number; threeY: number; threeZ: number } {
  const pose = evaluateSwingPath(keyframes, t);
  const tip = deriveTip(pose.hilt, pose.bladeDir, bladeLength);
  return {
    threeX:  tip.right,
    threeY:  tip.up,
    threeZ: -tip.fwd,
  };
}

/**
 * Evaluate hilt, tip, and blade direction at normalised time t in entity-local
 * Three.js space (right=X, up=Y, forward=-Z).
 *
 * bladeDirX/Y/Z is the normalised blade direction vector (hilt → tip).
 * Use it to orient the weapon model anchor so the visual blade aligns with
 * the swing path regardless of weapon length.
 */
export function evaluateWeaponSlice(
  keyframes: SwingKeyframe[],
  t: number,
  bladeLength: number,
): {
  hiltX: number; hiltY: number; hiltZ: number;
  tipX: number; tipY: number; tipZ: number;
  bladeDirX: number; bladeDirY: number; bladeDirZ: number;
} {
  const pose = evaluateSwingPath(keyframes, t);
  const tip = deriveTip(pose.hilt, pose.bladeDir, bladeLength);
  return {
    hiltX:  pose.hilt.right,
    hiltY:  pose.hilt.up,
    hiltZ: -pose.hilt.fwd,
    tipX:   tip.right,
    tipY:   tip.up,
    tipZ:  -tip.fwd,
    bladeDirX:  pose.bladeDir.right,
    bladeDirY:  pose.bladeDir.up,
    bladeDirZ: -pose.bladeDir.fwd,
  };
}
