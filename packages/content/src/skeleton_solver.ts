/**
 * Skeleton FK solver — shared between server (HitboxSystem) and client
 * (skeleton_evaluator.ts wrapper).
 *
 * Works entirely in solver space (x=right, y=up, z=-fwd).
 *
 * Inbound conversion: bone rest offsets are in entity-local (right=restX, fwd=restY,
 * up=restZ) and are converted to solver space at the start of each bone's evaluation.
 *
 * Outbound conversion: BoneTransform.pos is solver-space. Callers (applyHitboxTemplate)
 * convert to entity-local (fwd=-z, right=x, up=y) when writing BodyPartVolume endpoints.
 * No other coordinate conversions happen inside this module.
 */
import type { SkeletonDef, BoneDef } from "./types.ts";
import type { BoneRotation, Quat } from "./ik_solver.ts";
import { quatFromEulerXYZ, applyQuat, quatMultiply } from "./ik_solver.ts";

export interface BoneTransform {
  /** Position in solver space (x=right, y=up, z=-fwd), relative to entity origin. */
  pos: { x: number; y: number; z: number };
  /** Orientation as unit quaternion in solver space (XYZ intrinsic Euler convention). */
  rot: Quat;
}

/** Pass as poseRotations to evaluate the rest pose (all bones at identity rotation). */
export const REST_POSE: ReadonlyMap<string, BoneRotation> = new Map();

const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };
const IDENTITY_TRANSFORM: BoneTransform = { pos: { x: 0, y: 0, z: 0 }, rot: IDENTITY_QUAT };

/**
 * Walk the skeleton hierarchy (root → leaf order, as declared in SkeletonDef)
 * and compute each bone's transform in solver space.
 *
 * @param skeleton       The skeleton definition. Bones must be in parent-before-child order.
 * @param boneIndex      Pre-built Map<boneId, BoneDef> from ContentStore.getBoneIndex().
 *                       Passed in to avoid linear searches inside the loop.
 * @param poseRotations  Bone id → Euler XYZ rotation in solver space.
 *                       Bones absent from this map use identity rotation.
 * @param scale          Uniform entity scale (converts voxel rest-units → world units).
 * @param morphParams    Optional per-axis rest multipliers from resolveMorphParams().
 *                       When provided, scales each bone's rest offset per its declared axes.
 * @param out            Optional output map. If provided, it is cleared and reused to
 *                       avoid allocation. Pass a persistent Map for pooling.
 */
export function solveSkeleton(
  skeleton: SkeletonDef,
  boneIndex: ReadonlyMap<string, BoneDef>,
  poseRotations: ReadonlyMap<string, BoneRotation>,
  scale: number,
  morphParams?: Record<string, number>,
  out?: Map<string, BoneTransform>,
): Map<string, BoneTransform> {
  const result: Map<string, BoneTransform> = out ?? new Map();
  if (out) out.clear();

  // Pre-build per-bone rest-axis multipliers from morph param declarations.
  const boneScaleX = new Map<string, number>();
  const boneScaleY = new Map<string, number>();
  const boneScaleZ = new Map<string, number>();
  if (morphParams && skeleton.morphParams) {
    for (const param of skeleton.morphParams) {
      const factor = morphParams[param.id] ?? 1.0;
      if (factor === 1.0) continue;
      for (const boneId of param.bones) {
        if (param.restAxis === "x") {
          boneScaleX.set(boneId, (boneScaleX.get(boneId) ?? 1.0) * factor);
        } else if (param.restAxis === "y") {
          boneScaleY.set(boneId, (boneScaleY.get(boneId) ?? 1.0) * factor);
        } else {
          boneScaleZ.set(boneId, (boneScaleZ.get(boneId) ?? 1.0) * factor);
        }
      }
    }
  }

  for (const bone of skeleton.bones) {
    const parentTransform: BoneTransform = bone.parent !== null
      ? (result.get(bone.parent) ?? IDENTITY_TRANSFORM)
      : IDENTITY_TRANSFORM;

    // Apply morph scale to rest components before coordinate conversion.
    const rx = bone.restX * (boneScaleX.get(bone.id) ?? 1.0);
    const ry = bone.restY * (boneScaleY.get(bone.id) ?? 1.0);
    const rz = bone.restZ * (boneScaleZ.get(bone.id) ?? 1.0);

    // Convert rest offset from entity-local to solver space.
    // Entity-local: right=restX, fwd=restY, up=restZ
    // Solver:       x=right,    y=up,      z=-fwd
    const restOffsetSolver = {
      x:  rx * scale,
      y:  rz * scale,
      z: -ry * scale,
    };

    // Rotate rest offset into parent's orientation (stays in solver space).
    const rotatedOffset = applyQuat(restOffsetSolver, parentTransform.rot);

    // Accumulate position in solver space.
    const bonePos = {
      x: parentTransform.pos.x + rotatedOffset.x,
      y: parentTransform.pos.y + rotatedOffset.y,
      z: parentTransform.pos.z + rotatedOffset.z,
    };

    // Compose orientation: parent * local.
    const euler = poseRotations.get(bone.id) ?? { x: 0, y: 0, z: 0 };
    const localRot = quatFromEulerXYZ(euler.x, euler.y, euler.z);
    const boneRot = quatMultiply(parentTransform.rot, localRot);

    result.set(bone.id, { pos: bonePos, rot: boneRot });
  }

  return result;
}
