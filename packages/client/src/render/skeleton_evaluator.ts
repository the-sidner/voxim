/**
 * Skeleton pose evaluator — Three.js wrapper around evaluateAnimationLayers()
 * plus the IK post-pass that overlays weapon/grip constraints.
 *
 * Pipeline (called each render frame):
 *   1. evaluatePose()     — FK: layer stack → bone Euler rotations
 *   2. buildDriveContext() — resolve named world-space targets (hilt, grip_l, …)
 *   3. applyIKChains()    — IK: for each active chain, solve two-bone IK toward its target
 *   4. updateSkeletonPose() (entity_mesh.ts) — write Euler rotations to THREE.Groups
 *
 * evaluateAnimationLayers() lives in @voxim/content so the server (HitboxSystem)
 * can also call it without Three.js.
 *
 * DriveContext is a plain Map<string, THREE.Vector3> in entity-local Three.js space.
 * Any system that can supply a named point adds it here before applyIKChains runs.
 * Currently only "hilt" is supplied (from the swing path), but the design
 * generalises: foot planting adds "ground_l"/"ground_r", off-hand grip adds "grip_l".
 */
import * as THREE from "three";
import type { SkeletonDef, AnimationClip, BoneMask, AnimationStateData, WeaponActionDef } from "@voxim/content";
import { evaluateAnimationLayers, solveTwoBoneIK } from "@voxim/content";
import { evaluateSwingPath, deriveTip } from "@voxim/content";
import type { SwingKeyframe } from "@voxim/content";
import type { EntityMeshGroup } from "./entity_mesh.ts";

// ---- types ----

/**
 * Named world-space targets in entity-local Three.js space (right=X, up=Y, fwd=-Z).
 * Built once per frame per entity by buildDriveContext().
 */
export type DriveContext = Map<string, THREE.Vector3>;

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

// ---- drive context ----

/**
 * Build the DriveContext for one entity from its current animation state.
 *
 * Currently populates "hilt" from the active weapon action's swing path,
 * extrapolating between server ticks for smooth 60fps arm movement.
 *
 * @param animState       Current AnimationStateData from the server.
 * @param weaponActionsMap All loaded WeaponActionDefs, keyed by id.
 * @param elapsed         Fractional ticks elapsed since last server update (for extrapolation).
 */
export function buildDriveContext(
  animState: AnimationStateData | null,
  weaponActionsMap: ReadonlyMap<string, WeaponActionDef>,
  elapsed: number,
  bladeLength?: number,
): DriveContext {
  const ctx: DriveContext = new Map();
  if (!animState?.weaponActionId) return ctx;

  const action = weaponActionsMap.get(animState.weaponActionId);
  if (!action?.swingPath?.keyframes?.length) return ctx;

  const totalTicks = action.windupTicks + action.activeTicks + action.winddownTicks;
  if (totalTicks <= 0) return ctx;

  const ticks = Math.min(animState.ticksIntoAction + elapsed, totalTicks);
  const t = ticks / totalTicks;
  const effectiveBladeLength = bladeLength ?? 1.0;
  const pose = evaluateSwingPath(action.swingPath.keyframes, t);
  // Convert entity-local (right, up, fwd) → Three.js (right=X, up=Y, fwd=-Z)
  ctx.set("hilt", new THREE.Vector3(pose.hilt.right, pose.hilt.up, -pose.hilt.fwd));

  // "tip" is available too — future chains (e.g. shield-tip) can use it.
  const tip = deriveTip(pose.hilt, pose.bladeDir, effectiveBladeLength);
  ctx.set("tip", new THREE.Vector3(tip.right, tip.up, -tip.fwd));

  return ctx;
}

// ---- IK post-pass ----

// Scratch objects — reused per chain to avoid per-frame allocation.
const _ikTarget    = new THREE.Vector3();
const _ikPole      = new THREE.Vector3();
const _ikInvParent = new THREE.Matrix4();

/**
 * Apply two-bone IK for each active chain in the skeleton.
 *
 * Must be called AFTER evaluatePose / updateSkeletonPose has set FK rotations,
 * and AFTER mesh.group.updateWorldMatrix() so bone world positions are current.
 *
 * @param mesh          Entity mesh whose bone Groups to rotate.
 * @param skeleton      Skeleton definition owning the ikChains list.
 * @param ikChainIds    Chain IDs to activate — from the current weapon action.
 * @param ctx           Drive context supplying named target positions.
 */
export function applyIKChains(
  mesh: EntityMeshGroup,
  skeleton: SkeletonDef,
  ikChainIds: readonly string[],
  ctx: DriveContext,
): void {
  if (!mesh.boneGroups || ikChainIds.length === 0 || !skeleton.ikChains?.length) return;

  // Ensure world matrices are current so bone world positions are correct.
  mesh.group.updateWorldMatrix(true, true);

  for (const chainId of ikChainIds) {
    const chain = skeleton.ikChains.find(c => c.id === chainId);
    if (!chain) continue;

    const target = ctx.get(chain.driveSource);
    if (!target) continue;

    const [boneAId, boneBId] = chain.bones;
    const boneAGroup = mesh.boneGroups.get(boneAId);
    const boneBGroup = mesh.boneGroups.get(boneBId);
    if (!boneAGroup || !boneBGroup || !boneAGroup.parent) continue;

    // Bone lengths from the Three.js rest-pose positions (already scaled at build time).
    const boneALen = boneBGroup.position.length();        // upper → lower
    const boneBChild = skeleton.bones.find(b => b.parent === boneBId);
    if (!boneBChild) continue;
    const boneBChildGroup = mesh.boneGroups.get(boneBChild.id);
    if (!boneBChildGroup) continue;
    const boneBLen = boneBChildGroup.position.length();   // lower → hand
    if (boneALen < 1e-4 || boneBLen < 1e-4) continue;

    // Express target and pole hint in bone A's parent space.
    _ikInvParent.copy((boneAGroup.parent as THREE.Object3D).matrixWorld).invert();

    _ikTarget.copy(target);
    mesh.group.localToWorld(_ikTarget);
    _ikTarget.applyMatrix4(_ikInvParent);

    const ph = chain.poleHint;
    _ikPole.set(ph.right, ph.up, -ph.fwd);
    _ikPole.transformDirection(mesh.group.matrixWorld);
    _ikPole.transformDirection(_ikInvParent);

    const { rotA, rotB } = solveTwoBoneIK(
      boneALen, boneBLen,
      { x: _ikTarget.x, y: _ikTarget.y, z: _ikTarget.z },
      { x: _ikPole.x,   y: _ikPole.y,   z: _ikPole.z   },
    );
    boneAGroup.rotation.set(rotA.x, rotA.y, rotA.z);
    boneBGroup.rotation.set(rotB.x, rotB.y, rotB.z);
  }
}

// ---- weapon position evaluation (used by trail + attachment) ----

/**
 * Evaluate the weapon tip position at normalised time t in entity-local Three.js space.
 */
export function evaluateWeaponTip(
  keyframes: SwingKeyframe[],
  t: number,
  bladeLength: number,
): { threeX: number; threeY: number; threeZ: number } {
  const pose = evaluateSwingPath(keyframes, t);
  const tip = deriveTip(pose.hilt, pose.bladeDir, bladeLength);
  return { threeX: tip.right, threeY: tip.up, threeZ: -tip.fwd };
}

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
