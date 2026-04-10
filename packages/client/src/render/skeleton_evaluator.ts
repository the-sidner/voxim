/**
 * Skeleton pose evaluator — thin Three.js wrapper around @voxim/content pose functions.
 *
 * computeHumanPose / computeWolfPose live in @voxim/content so the server can
 * also call them (no Three.js there). This file only converts BoneRotation
 * (plain {x,y,z} Euler XYZ) → THREE.Euler so the renderer can use them.
 */
import * as THREE from "three";
import type { AnimationMode, SwingKeyframe, IKTargetDef } from "@voxim/content";
import { computeHumanPose, computeWolfPose } from "@voxim/content";
import type { HumanWeaponData } from "@voxim/content";
import { evaluateSwingPath, deriveTip } from "@voxim/content";

// ---- public API ----

export function evaluatePose(
  skeletonId: string,
  mode: AnimationMode,
  _attackStyle: string,
  windupTicks: number,
  activeTicks: number,
  winddownTicks: number,
  ticksIntoAction: number,
  serverTick: number,
  velocityX = 0,
  velocityY = 0,
  facingAngle = 0,
  swingKeyframes?: SwingKeyframe[],
  ikTargets?: IKTargetDef[],
  bladeLength?: number,
): Map<string, THREE.Euler> {
  if (skeletonId === "human") {
    const weaponData: HumanWeaponData | undefined = swingKeyframes
      ? { keyframes: swingKeyframes, ikTargets, windupTicks, activeTicks, winddownTicks, ticksIntoAction, bladeLength: bladeLength ?? 1.0 }
      : undefined;
    const boneRotations = computeHumanPose(mode, serverTick, velocityX, velocityY, facingAngle, weaponData);
    return toThreeEulerMap(boneRotations);
  }

  if (skeletonId === "wolf") {
    const weaponData = { windupTicks, activeTicks, winddownTicks, ticksIntoAction };
    const boneRotations = computeWolfPose(mode, serverTick, velocityX, velocityY, weaponData);
    return toThreeEulerMap(boneRotations);
  }

  return new Map();
}

/** Convert a BoneRotation map (plain Euler XYZ) to THREE.Euler. */
function toThreeEulerMap(input: Map<string, { x: number; y: number; z: number }>): Map<string, THREE.Euler> {
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
