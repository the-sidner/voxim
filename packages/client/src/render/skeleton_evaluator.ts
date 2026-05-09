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
 * `evaluateBladeWorld` produces world-space blade endpoints by transforming
 * `WeaponActionDef.blade.baseLocal` / `tipLocal` by the holding-hand bone's
 * `matrixWorld` — same blade authoring as the server hit detection, so the
 * trail ribbon and hit capsule are guaranteed to match.
 */
import * as THREE from "three";
import type { SkeletonDef, AnimationClip, BoneMask, AnimationStateData, WeaponBladeDef } from "@voxim/content";
import { evaluateAnimationLayers } from "@voxim/content";
import type { EntityMeshGroup } from "./entity_mesh.ts";

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

// ---- weapon blade endpoints from FK (used by trail + attachment + debug overlay) ----

const _bladeBase = new THREE.Vector3();
const _bladeTip  = new THREE.Vector3();

/**
 * Compute world-space blade endpoints from the FK-evaluated holding-hand bone.
 *
 * `blade.baseLocal` / `tipLocal` are in hand-bone-local space (matching the
 * bone restX/Y/Z units and three.js axes — right=X, up=Y, fwd=-Z). Multiplying
 * by the hand bone's `matrixWorld` directly yields world-space endpoints
 * because mesh.group's entity scale is already baked into matrixWorld.
 *
 * Returns null when the requested bone isn't on this mesh — trail / overlay
 * code skips the entity for that frame.
 */
export function evaluateBladeWorld(
  mesh: EntityMeshGroup,
  blade: WeaponBladeDef,
  holdBoneId: string,
  outBase: THREE.Vector3 = new THREE.Vector3(),
  outTip:  THREE.Vector3 = new THREE.Vector3(),
): { base: THREE.Vector3; tip: THREE.Vector3 } | null {
  const bone = mesh.boneGroups?.get(holdBoneId);
  if (!bone) return null;
  bone.updateWorldMatrix(true, false);
  const mat = bone.matrixWorld;
  outBase.set(blade.baseLocal[0], blade.baseLocal[1], blade.baseLocal[2]).applyMatrix4(mat);
  outTip .set(blade.tipLocal[0],  blade.tipLocal[1],  blade.tipLocal[2] ).applyMatrix4(mat);
  return { base: outBase, tip: outTip };
}

/** Scratch vectors callers can reuse to avoid allocation. */
export function bladeScratch(): { base: THREE.Vector3; tip: THREE.Vector3 } {
  return { base: _bladeBase, tip: _bladeTip };
}
