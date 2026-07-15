/**
 * Pose composer — the constraint-producer stage of the animation pipeline.
 *
 * Base FK (skeleton_evaluator) → THIS registered producer list → rewrap.
 * Each producer takes the previous stage's pose as its base pose so they
 * compose on one skeleton (T-308); the order is load-bearing and preserved
 * exactly from the renderer's original hand-sequenced chain:
 *
 *   legs (gait ⊻ crouch) → locomotion lean → swing overlay
 *     → foot-terrain IK → head stabilization
 *
 * The weapon-style clip's UPPER body (arms/spine/head) rides through
 * untouched — only the gait/crouch/swing producers override bones, and
 * gait+crouch only ever touch the leg chain. No per-weapon-style branches
 * here: add producers, not special cases.
 */
import type { BoneDef, BoneRotation, GaitDef, LocoState, SkeletonDef, SwingPathDef } from "@voxim/content";
import {
  applyCrouchPose,
  applyFootTerrainIK,
  applyGaitPose,
  applyLocomotionPose,
  applyLookAtPose,
  solveSwingPose,
} from "@voxim/content";

/** Everything one frame's producer chain needs for one entity. */
export interface PoseComposeContext {
  skeleton: SkeletonDef;
  boneIndex: ReadonlyMap<string, BoneDef>;
  scale: number;
  morphParams?: Record<string, number>;
  loco: LocoState | null;
  gaitDef: GaitDef | undefined;
  /** Normalised gait cycle position [0,1) — advanced by ground distance, not time. */
  gaitPhase: number;
  /** Eased pelvis drop in world units; 0 when not crouching. */
  dropY: number;
  swingPath: SwingPathDef | undefined;
  /** Normalised swing time t∈[0,1]; only read when swingPath is set. */
  swingT: number;
  /** Ground-plane position + facing shared by gait accumulation and foot IK. */
  ground: { x: number; y: number; facing: number };
  /** Terrain height sampler; null disables the foot-terrain producer. */
  heightAt: ((worldX: number, worldY: number) => number) | null;
  lookAtGain: number;
}

export type PoseProducer = (
  ctx: PoseComposeContext,
  pose: Map<string, BoneRotation>,
) => Map<string, BoneRotation>;

/**
 * Legs: gait OWNS the legs while moving — supersedes applyCrouchPose's own
 * foot-replant, passing the SAME pelvis-drop rootOffset when also crouching
 * so crouch + walk compose without either producer needing to run first
 * (see applyGaitPose's doc). Mutually exclusive with the crouch producer by
 * construction, not by ordering.
 */
const legsProducer: PoseProducer = (ctx, pose) => {
  if (ctx.loco && ctx.gaitDef) {
    const rootOffset = ctx.dropY > 0 ? { x: 0, y: -ctx.dropY, z: 0 } : undefined;
    return applyGaitPose(
      ctx.skeleton, ctx.boneIndex, pose, ctx.scale, ctx.gaitDef, ctx.gaitPhase, ctx.loco,
      { rootOffset, morphParams: ctx.morphParams },
    );
  }
  if (ctx.dropY > 0) {
    return applyCrouchPose(ctx.skeleton, ctx.boneIndex, pose, ctx.scale, ctx.dropY, { morphParams: ctx.morphParams });
  }
  return pose;
};

const locomotionProducer: PoseProducer = (ctx, pose) =>
  ctx.loco
    ? applyLocomotionPose(ctx.skeleton, ctx.boneIndex, pose, ctx.scale, ctx.loco, { morphParams: ctx.morphParams })
    : pose;

const swingProducer: PoseProducer = (ctx, pose) =>
  ctx.swingPath
    ? solveSwingPose(ctx.skeleton, ctx.boneIndex, pose, ctx.scale, ctx.swingPath, ctx.swingT, { morphParams: ctx.morphParams })
    : pose;

/**
 * Foot-terrain IK (T-308/T-186): re-plant feet at the local ground height
 * once something else already put this entity through the extra pose pass
 * (walking/crouching/swinging) — a fully idle entity's rest pose has no lean
 * to correct against a slope yet, see swing_pose.ts's applyFootTerrainIK doc
 * for the scoping note.
 */
const footTerrainProducer: PoseProducer = (ctx, pose) => {
  if (!ctx.heightAt) return pose;
  return applyFootTerrainIK(
    ctx.skeleton, ctx.boneIndex, pose, ctx.scale,
    { x: ctx.ground.x, y: ctx.ground.y }, ctx.ground.facing, ctx.heightAt,
    { morphParams: ctx.morphParams },
  );
};

/** Head/gaze stabilization — last, so it corrects the FINAL composed lean
 *  (crouch + locomotion + swing) rather than an intermediate one. */
const lookAtProducer: PoseProducer = (ctx, pose) =>
  applyLookAtPose(ctx.skeleton, ctx.boneIndex, pose, ctx.scale, ctx.lookAtGain, { morphParams: ctx.morphParams });

/** Fixed pipeline order — see module doc. Order is load-bearing. */
const POSE_PRODUCERS: readonly PoseProducer[] = [
  legsProducer,
  locomotionProducer,
  swingProducer,
  footTerrainProducer,
  lookAtProducer,
];

/** Run the full producer chain over a base-FK pose. */
export function composePose(
  ctx: PoseComposeContext,
  basePose: Map<string, BoneRotation>,
): Map<string, BoneRotation> {
  let pose = basePose;
  for (const producer of POSE_PRODUCERS) pose = producer(ctx, pose);
  return pose;
}
