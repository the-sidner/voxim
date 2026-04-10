/**
 * Procedural skeleton pose evaluator — three-stage pipeline.
 *
 * Stage 1: Base FK pose
 *   Lower body always plays locomotion (idle sway / walk gait).
 *   Upper body plays locomotion unless overridden.
 *
 * Stage 2: Constraint producers
 *   During attacks, the weapon animation layer reads swingPath + ikTargets
 *   from the weapon action to produce IK constraints. Torso lean/twist is
 *   derived from the hilt position. Other producers (look-at, foot planting)
 *   can add constraints from other sources in the future.
 *
 * Stage 3: Constraint solver
 *   Solves all constraints generically. Two-bone IK uses ik_solver.ts.
 *   Results override FK bone rotations in the pose map.
 *
 * Directional walk mapping:
 *   facingAngle is the world-space heading (radians, counter-clockwise from +X).
 *   Velocity (vx, vy) is rotated into local facing space:
 *     localFwd    = -vx·sin(facing) + vy·cos(facing)   ← + = backward
 *     localStrafe =  vx·cos(facing) + vy·sin(facing)   ← + = strafe-right
 *
 * Bone hierarchy (human):
 *   root → torso_lower → torso_mid → torso_upper → head
 *                                  ↘ upper_arm_l → lower_arm_l → hand_l
 *                                  ↘ upper_arm_r → lower_arm_r → hand_r
 *        → upper_leg_l → lower_leg_l → foot_l
 *        → upper_leg_r → lower_leg_r → foot_r
 */
import * as THREE from "three";
import type { AnimationMode, SwingKeyframe, IKTargetDef } from "@voxim/content";
import { evaluateSwingPath, deriveTip } from "@voxim/content";
import { solveTwoBoneIK } from "./ik_solver.ts";

// ---- constants ----

const WALK_FREQ   = 0.25;   // rad/tick gait cycle
const WALK_AMP    = 0.75;   // upper-leg swing (rad)
const KNEE_AMP    = 0.55;   // max knee-bend (rad)
const ARM_AMP     = 0.55;   // upper-arm swing (rad)
const ELBOW_AMP   = 0.35;   // elbow curl (rad)

const BREATH_FREQ = 0.08;   // rad/tick (~2.4 s at 20 Hz)
const BREATH_AMP  = 0.05;
const SWAY_FREQ   = 0.05;   // rad/tick
const SWAY_AMP    = 0.025;

/** Below this world-speed the locomotion is treated as idle. */
const WALK_SPEED_THRESHOLD = 0.05;

/** Human arm bone length in Three.js units (restZ=2 × scale=0.35). */
const ARM_BONE_LEN = 0.7;

/**
 * Shoulder rest position in Three.js entity-local space.
 * Accumulated from: root(0) + torso_lower(1.05y) + torso_mid(0.35y) + torso_upper(0.35y) + upper_arm(±0.7x).
 */
const SHOULDER_REST_Y = 1.75;  // height above entity origin

// ---- constraint types ----

/** A bone-chain constraint to solve after FK. */
interface PoseConstraint {
  type: "two-bone-ik";
  chain: [string, string];
  target: THREE.Vector3;
  poleHint: THREE.Vector3;
}

// ---- public API ----

export function evaluatePose(
  skeletonId: string,
  mode: AnimationMode,
  attackStyle: string,
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
  const pose = new Map<string, THREE.Euler>();
  if (skeletonId === "human") {
    evaluateHumanPose(pose, mode, attackStyle, windupTicks, activeTicks, winddownTicks, ticksIntoAction, serverTick, velocityX, velocityY, facingAngle, swingKeyframes, ikTargets, bladeLength);
  } else if (skeletonId === "wolf") {
    evaluateWolfPose(pose, mode, windupTicks, activeTicks, winddownTicks, ticksIntoAction, serverTick, velocityX, velocityY);
  }
  return pose;
}

// ---- helpers ----

function worldVelToLocal(vx: number, vy: number, facing: number): [number, number] {
  const c = Math.cos(facing), s = Math.sin(facing);
  const localFwd    = -vx * s + vy * c;
  const localStrafe =  vx * c + vy * s;
  return [localFwd, localStrafe];
}

/** Compute normalised progress t ∈ [0,1] across the full action arc. */
function actionT(windupTicks: number, activeTicks: number, winddownTicks: number, ticksIntoAction: number): number {
  const total = windupTicks + activeTicks + winddownTicks;
  return total > 0 ? Math.min(ticksIntoAction / total, 1.0) : 1.0;
}

// ---- human evaluator ----

function evaluateHumanPose(
  pose: Map<string, THREE.Euler>,
  mode: AnimationMode,
  _attackStyle: string,
  windupTicks: number,
  activeTicks: number,
  winddownTicks: number,
  ticksIntoAction: number,
  tick: number,
  vx: number,
  vy: number,
  facing: number,
  swingKeyframes?: SwingKeyframe[],
  ikTargets?: IKTargetDef[],
  bladeLength?: number,
): void {
  const speed = Math.sqrt(vx * vx + vy * vy);
  const moving = speed > WALK_SPEED_THRESHOLD;
  const [localFwd, localStrafe] = worldVelToLocal(vx, vy, facing);

  // Stage 1: Base FK
  lowerBodyLocomotion(pose, tick, moving, localFwd, localStrafe, speed);

  if (mode === "attack" && swingKeyframes) {
    // Stage 2: Weapon animation layer produces constraints
    const t = actionT(windupTicks, activeTicks, winddownTicks, ticksIntoAction);
    const constraints = weaponAnimationLayer(pose, t, swingKeyframes, ikTargets, bladeLength ?? 1.0);

    // Stage 3: Generic constraint solver
    solveConstraints(pose, constraints);
  } else if (mode === "death") {
    upperBodyDeath(pose);
    lowerBodyDeath(pose);
  } else if (mode === "crouch" || mode === "crouch_walk") {
    lowerBodyCrouch(pose, tick, moving, localFwd, localStrafe, speed);
    upperBodyCrouch(pose, tick, moving, localFwd, localStrafe);
  } else {
    upperBodyLocomotion(pose, tick, moving, localFwd, localStrafe);
  }
}

// ── Stage 2: Weapon animation layer ──────────────────────────────────────────

/**
 * Produces IK constraints from weapon action data. Sets torso/head FK from
 * the hilt position (derived, not per-style). Sets passive pose for non-IK arms.
 */
function weaponAnimationLayer(
  pose: Map<string, THREE.Euler>,
  t: number,
  keyframes: SwingKeyframe[],
  ikTargets: IKTargetDef[] | undefined,
  bladeLength: number,
): PoseConstraint[] {
  const swing = evaluateSwingPath(keyframes, t);

  // Derive torso body language from hilt position (generic, not per-style)
  const torsoTwist = -swing.hilt.right * 0.25;
  const torsoLean  = -(swing.hilt.fwd - 0.2) * 0.08;
  pose.set("torso_mid",   new THREE.Euler(torsoLean, torsoTwist * 0.7, 0));
  pose.set("torso_upper", new THREE.Euler(torsoLean * 1.2, torsoTwist, 0));
  pose.set("head",        new THREE.Euler(0, torsoTwist * 0.3, 0));

  // Produce IK constraints from weapon action data
  const constraints: PoseConstraint[] = [];
  const constrainedBones = new Set<string>();

  if (ikTargets) {
    for (const ik of ikTargets) {
      // Determine the IK target position in entity-local (fwd, right, up)
      const srcLocal = ik.source === "hilt"
        ? swing.hilt
        : deriveTip(swing.hilt, swing.bladeDir, bladeLength);

      // Convert to Three.js entity-local: (right, up, -fwd)
      const target = new THREE.Vector3(srcLocal.right, srcLocal.up, -srcLocal.fwd);
      const pole = new THREE.Vector3(ik.poleHint.right, ik.poleHint.up, -ik.poleHint.fwd);

      constraints.push({ type: "two-bone-ik", chain: ik.chain, target, poleHint: pole });
      constrainedBones.add(ik.chain[0]);
      constrainedBones.add(ik.chain[1]);
    }
  }

  // Passive pose for non-constrained arm bones
  if (!constrainedBones.has("upper_arm_l")) {
    pose.set("upper_arm_l", new THREE.Euler(0.08, 0, -0.18));
    pose.set("lower_arm_l", new THREE.Euler(0.12, 0, 0));
    pose.set("hand_l",      new THREE.Euler(0.08, 0, 0));
  }
  if (!constrainedBones.has("upper_arm_r")) {
    pose.set("upper_arm_r", new THREE.Euler(0.08, 0, 0.18));
    pose.set("lower_arm_r", new THREE.Euler(0.12, 0, 0));
    pose.set("hand_r",      new THREE.Euler(0.08, 0, 0));
  }

  return constraints;
}

// ── Stage 3: Generic constraint solver ───────────────────────────────────────

// Reusable scratch vectors for constraint solving
const _shoulderOffset = new THREE.Vector3();
const _localTarget = new THREE.Vector3();
const _torsoQuat = new THREE.Quaternion();
const _invTorsoQuat = new THREE.Quaternion();

function solveConstraints(
  pose: Map<string, THREE.Euler>,
  constraints: PoseConstraint[],
): void {
  for (const c of constraints) {
    switch (c.type) {
      case "two-bone-ik": {
        // Determine shoulder offset from bone chain root name
        const isLeft = c.chain[0].endsWith("_l");
        const shoulderX = isLeft ? -ARM_BONE_LEN : ARM_BONE_LEN;

        // Compute the accumulated torso rotation (torso_mid + torso_upper)
        // to transform the IK target from entity-local into shoulder-local space.
        const torsoMidRot = pose.get("torso_mid");
        const torsoUpperRot = pose.get("torso_upper");
        _torsoQuat.identity();
        if (torsoMidRot)   _torsoQuat.multiply(new THREE.Quaternion().setFromEuler(torsoMidRot));
        if (torsoUpperRot) _torsoQuat.multiply(new THREE.Quaternion().setFromEuler(torsoUpperRot));
        _invTorsoQuat.copy(_torsoQuat).invert();

        // Shoulder position in entity-local Three.js space (after torso rotations)
        _shoulderOffset.set(shoulderX, SHOULDER_REST_Y, 0);
        // Note: torso rotations are small, so the shoulder position shift is minor.
        // For accuracy, rotate the shoulder offset by torso rotation:
        _shoulderOffset.applyQuaternion(_torsoQuat);

        // Target in shoulder-local space
        _localTarget.copy(c.target).sub(_shoulderOffset).applyQuaternion(_invTorsoQuat);

        // Solve IK
        const poleLocal = c.poleHint.clone().applyQuaternion(_invTorsoQuat);
        const result = solveTwoBoneIK(ARM_BONE_LEN, ARM_BONE_LEN, _localTarget, poleLocal);

        pose.set(c.chain[0], result.rotA);
        pose.set(c.chain[1], result.rotB);
        break;
      }
    }
  }
}

// ── lower body ───────────────────────────────────────────────────────────────

function lowerBodyLocomotion(
  pose: Map<string, THREE.Euler>,
  tick: number,
  moving: boolean,
  localFwd: number,
  localStrafe: number,
  speed: number,
): void {
  if (!moving) {
    const sway = Math.sin(tick * SWAY_FREQ) * SWAY_AMP;
    pose.set("root",        new THREE.Euler(0, 0, 0));
    pose.set("torso_lower", new THREE.Euler(0, sway, 0));
    pose.set("upper_leg_l", new THREE.Euler(0, 0, 0));
    pose.set("lower_leg_l", new THREE.Euler(0.06, 0, 0));
    pose.set("upper_leg_r", new THREE.Euler(0, 0, 0));
    pose.set("lower_leg_r", new THREE.Euler(0.06, 0, 0));
    pose.set("foot_l",      new THREE.Euler(0, 0, 0));
    pose.set("foot_r",      new THREE.Euler(0, 0, 0));
    pose.set("hand_l",      new THREE.Euler(0.1, 0, 0));
    pose.set("hand_r",      new THREE.Euler(0.1, 0, 0));
    return;
  }

  const fwdSign   = localFwd >= 0 ? 1 : -1;
  const speedMult = Math.min(speed / 4.0, 1.0);

  const phase   = tick * WALK_FREQ * fwdSign;
  const swing   = Math.sin(phase) * WALK_AMP * speedMult;
  const kneeL   = 0.3 + Math.max(0, -Math.sin(phase)) * KNEE_AMP * speedMult;
  const kneeR   = 0.3 + Math.max(0,  Math.sin(phase)) * KNEE_AMP * speedMult;
  const bob     = Math.abs(Math.sin(phase)) * 0.015;
  const hipLean = localStrafe * 0.08;

  pose.set("root",        new THREE.Euler(-0.04 - bob, 0, 0));
  pose.set("torso_lower", new THREE.Euler(0.04, swing * 0.12 + hipLean, 0));
  pose.set("upper_leg_l", new THREE.Euler( swing, 0, 0));
  pose.set("lower_leg_l", new THREE.Euler(kneeL, 0, 0));
  pose.set("upper_leg_r", new THREE.Euler(-swing, 0, 0));
  pose.set("lower_leg_r", new THREE.Euler(kneeR, 0, 0));
  pose.set("foot_l",      new THREE.Euler(0, 0, 0));
  pose.set("foot_r",      new THREE.Euler(0, 0, 0));
  pose.set("hand_l",      new THREE.Euler(0.1, 0, 0));
  pose.set("hand_r",      new THREE.Euler(0.1, 0, 0));
}

function lowerBodyDeath(pose: Map<string, THREE.Euler>): void {
  pose.set("root",        new THREE.Euler(0, 0, Math.PI / 2));
  pose.set("torso_lower", new THREE.Euler(0, 0, 0));
  pose.set("upper_leg_l", new THREE.Euler(0.1,  0, -0.25));
  pose.set("lower_leg_l", new THREE.Euler(0.25, 0, 0));
  pose.set("upper_leg_r", new THREE.Euler(-0.15, 0, 0.2));
  pose.set("lower_leg_r", new THREE.Euler(0.15, 0, 0));
}

// ── upper body ───────────────────────────────────────────────────────────────

function upperBodyLocomotion(
  pose: Map<string, THREE.Euler>,
  tick: number,
  moving: boolean,
  localFwd: number,
  localStrafe: number,
): void {
  const breath = Math.sin(tick * BREATH_FREQ) * BREATH_AMP;
  const sway   = Math.sin(tick * SWAY_FREQ)   * SWAY_AMP;

  if (!moving) {
    pose.set("torso_mid",   new THREE.Euler(breath * 0.4, -sway * 0.5, 0));
    pose.set("torso_upper", new THREE.Euler(breath, sway * 0.3, 0));
    pose.set("head",        new THREE.Euler(-breath * 0.3, Math.sin(tick * SWAY_FREQ * 0.7) * 0.02, 0));
    pose.set("upper_arm_l", new THREE.Euler(0.08, 0, -0.18));
    pose.set("lower_arm_l", new THREE.Euler(0.12, 0, 0));
    pose.set("upper_arm_r", new THREE.Euler(0.08, 0,  0.18));
    pose.set("lower_arm_r", new THREE.Euler(0.12, 0, 0));
    pose.set("hand_l",      new THREE.Euler(0.08, 0, 0));
    pose.set("hand_r",      new THREE.Euler(0.08, 0, 0));
    return;
  }

  const fwdSign   = localFwd >= 0 ? 1 : -1;
  const phase     = tick * WALK_FREQ * fwdSign;
  const swing     = Math.sin(phase);
  const armSwing  = swing * ARM_AMP;
  const elbowBend = 0.25 + Math.abs(swing) * ELBOW_AMP;

  const spineTwist  = swing * 0.10;
  const leanFwd     = localFwd    * 0.04;
  const strafeSplay = localStrafe * 0.08;

  pose.set("torso_mid",   new THREE.Euler(leanFwd + 0.02, -spineTwist * 0.8, 0));
  pose.set("torso_upper", new THREE.Euler(leanFwd + 0.04, -spineTwist, 0));
  pose.set("head",        new THREE.Euler(leanFwd * 0.3, swing * 0.04, 0));
  pose.set("upper_arm_l", new THREE.Euler(-armSwing, 0, -0.12 - strafeSplay));
  pose.set("lower_arm_l", new THREE.Euler(elbowBend, 0, 0));
  pose.set("upper_arm_r", new THREE.Euler( armSwing, 0,  0.12 - strafeSplay));
  pose.set("lower_arm_r", new THREE.Euler(elbowBend, 0, 0));
  pose.set("hand_l",      new THREE.Euler(elbowBend * 0.3, 0, 0));
  pose.set("hand_r",      new THREE.Euler(elbowBend * 0.3, 0, 0));
}

function upperBodyDeath(pose: Map<string, THREE.Euler>): void {
  pose.set("torso_mid",   new THREE.Euler(0, 0, 0));
  pose.set("torso_upper", new THREE.Euler(0, 0, 0));
  pose.set("head",        new THREE.Euler(0, 0, 0.15));
  pose.set("upper_arm_l", new THREE.Euler(0.2, 0, -0.9));
  pose.set("lower_arm_l", new THREE.Euler(0.4, 0, 0));
  pose.set("upper_arm_r", new THREE.Euler(-0.1, 0, 0.6));
  pose.set("lower_arm_r", new THREE.Euler(0.3, 0, 0));
}

// ── crouch poses ─────────────────────────────────────────────────────────────

const CROUCH_HIP_FLEX  = 0.90;  // upper-leg forward tilt (hip flex)
const CROUCH_KNEE_BEND = 1.10;  // lower-leg bend (knee)
const CROUCH_TORSO_FWD = 0.35;  // forward lean of torso
const CROUCH_WALK_FREQ = 0.18;  // slower gait cycle while crouched
const CROUCH_WALK_AMP  = 0.30;  // reduced leg swing amplitude

function lowerBodyCrouch(
  pose: Map<string, THREE.Euler>,
  tick: number,
  moving: boolean,
  localFwd: number,
  localStrafe: number,
  speed: number,
): void {
  if (!moving) {
    const sway = Math.sin(tick * SWAY_FREQ) * SWAY_AMP * 0.5;
    pose.set("root",        new THREE.Euler(-0.08, 0, 0));
    pose.set("torso_lower", new THREE.Euler(0, sway, 0));
    pose.set("upper_leg_l", new THREE.Euler(CROUCH_HIP_FLEX, 0, 0));
    pose.set("lower_leg_l", new THREE.Euler(CROUCH_KNEE_BEND, 0, 0));
    pose.set("upper_leg_r", new THREE.Euler(CROUCH_HIP_FLEX, 0, 0));
    pose.set("lower_leg_r", new THREE.Euler(CROUCH_KNEE_BEND, 0, 0));
    pose.set("foot_l",      new THREE.Euler(-0.15, 0, 0));
    pose.set("foot_r",      new THREE.Euler(-0.15, 0, 0));
    pose.set("hand_l",      new THREE.Euler(0.1, 0, 0));
    pose.set("hand_r",      new THREE.Euler(0.1, 0, 0));
    return;
  }

  const fwdSign   = localFwd >= 0 ? 1 : -1;
  const speedMult = Math.min(speed / 3.0, 1.0);
  const phase     = tick * CROUCH_WALK_FREQ * fwdSign;
  const swing     = Math.sin(phase) * CROUCH_WALK_AMP * speedMult;
  const hipLean   = localStrafe * 0.06;

  pose.set("root",        new THREE.Euler(-0.08, 0, 0));
  pose.set("torso_lower", new THREE.Euler(0, swing * 0.10 + hipLean, 0));
  pose.set("upper_leg_l", new THREE.Euler(CROUCH_HIP_FLEX + swing,  0, 0));
  pose.set("lower_leg_l", new THREE.Euler(CROUCH_KNEE_BEND + Math.max(0, -swing) * 0.25, 0, 0));
  pose.set("upper_leg_r", new THREE.Euler(CROUCH_HIP_FLEX - swing,  0, 0));
  pose.set("lower_leg_r", new THREE.Euler(CROUCH_KNEE_BEND + Math.max(0,  swing) * 0.25, 0, 0));
  pose.set("foot_l",      new THREE.Euler(-0.15, 0, 0));
  pose.set("foot_r",      new THREE.Euler(-0.15, 0, 0));
  pose.set("hand_l",      new THREE.Euler(0.1, 0, 0));
  pose.set("hand_r",      new THREE.Euler(0.1, 0, 0));
}

function upperBodyCrouch(
  pose: Map<string, THREE.Euler>,
  tick: number,
  moving: boolean,
  _localFwd: number,
  _localStrafe: number,
): void {
  const breath = Math.sin(tick * BREATH_FREQ) * BREATH_AMP * 0.6;
  const sway   = Math.sin(tick * SWAY_FREQ)   * SWAY_AMP   * 0.5;

  pose.set("torso_mid",   new THREE.Euler(CROUCH_TORSO_FWD + breath * 0.3, -sway * 0.4, 0));
  pose.set("torso_upper", new THREE.Euler(CROUCH_TORSO_FWD * 0.6 + breath, sway * 0.2, 0));
  pose.set("head",        new THREE.Euler(-CROUCH_TORSO_FWD * 0.5 - breath * 0.3, moving ? 0 : Math.sin(tick * SWAY_FREQ * 0.7) * 0.015, 0));
  // Arms hang slightly forward in crouch
  pose.set("upper_arm_l", new THREE.Euler(0.15, 0, -0.22));
  pose.set("lower_arm_l", new THREE.Euler(0.20, 0, 0));
  pose.set("upper_arm_r", new THREE.Euler(0.15, 0,  0.22));
  pose.set("lower_arm_r", new THREE.Euler(0.20, 0, 0));
  pose.set("hand_l",      new THREE.Euler(0.10, 0, 0));
  pose.set("hand_r",      new THREE.Euler(0.10, 0, 0));
}

// ── Wolf (quadruped) ─────────────────────────────────────────────────────────

const WOLF_TROT_FREQ  = 0.28;
const WOLF_LEG_AMP   = 0.65;
const WOLF_KNEE_AMP  = 0.45;
const WOLF_TAIL_FREQ = 0.15;

function evaluateWolfPose(
  pose: Map<string, THREE.Euler>,
  mode: AnimationMode,
  windupTicks: number,
  activeTicks: number,
  winddownTicks: number,
  ticksIntoAction: number,
  tick: number,
  vx: number,
  vy: number,
): void {
  const speed  = Math.sqrt(vx * vx + vy * vy);
  const moving = speed > WALK_SPEED_THRESHOLD;

  if (mode === "death") {
    pose.set("body",     new THREE.Euler(0, 0, Math.PI / 2));
    pose.set("head",     new THREE.Euler(0.3, 0, 0));
    pose.set("tail",     new THREE.Euler(0, 0, -0.4));
    pose.set("fl_upper", new THREE.Euler(0.2,  0, -0.3));
    pose.set("fl_lower", new THREE.Euler(0.15, 0, 0));
    pose.set("fr_upper", new THREE.Euler(-0.1, 0,  0.25));
    pose.set("fr_lower", new THREE.Euler(0.2,  0, 0));
    pose.set("rl_upper", new THREE.Euler(0.1,  0, -0.2));
    pose.set("rl_lower", new THREE.Euler(0.3,  0, 0));
    pose.set("rr_upper", new THREE.Euler(-0.2, 0,  0.2));
    pose.set("rr_lower", new THREE.Euler(0.1,  0, 0));
    return;
  }

  if (mode === "attack") {
    const t = actionT(windupTicks, activeTicks, winddownTicks, ticksIntoAction);
    const lunge = t < 0.3
      ? -(t / 0.3) * 0.5
      : t < 0.55
        ? -0.5 + ((t - 0.3) / 0.25) * 0.9
        : 0.4 - ((t - 0.55) / 0.45) * 0.4;
    pose.set("body",     new THREE.Euler(lunge, 0, 0));
    pose.set("head",     new THREE.Euler(-lunge * 0.6 - 0.1, 0, 0));
    pose.set("tail",     new THREE.Euler(0, 0, 0));
    const legs = new THREE.Euler(0.08, 0, 0);
    const lowers = new THREE.Euler(0.06, 0, 0);
    for (const b of ["fl_upper", "fr_upper", "rl_upper", "rr_upper"]) pose.set(b, legs);
    for (const b of ["fl_lower", "fr_lower", "rl_lower", "rr_lower"]) pose.set(b, lowers);
    return;
  }

  if (!moving) {
    const breath  = Math.sin(tick * BREATH_FREQ) * 0.03;
    const tailWag = Math.sin(tick * WOLF_TAIL_FREQ) * 0.18;
    pose.set("body",     new THREE.Euler(breath, 0, 0));
    pose.set("head",     new THREE.Euler(-breath * 0.5, 0, 0));
    pose.set("tail",     new THREE.Euler(0, tailWag, 0));
    const rest = new THREE.Euler(0, 0, 0);
    const knee = new THREE.Euler(0.06, 0, 0);
    for (const b of ["fl_upper", "fr_upper", "rl_upper", "rr_upper"]) pose.set(b, rest);
    for (const b of ["fl_lower", "fr_lower", "rl_lower", "rr_lower"]) pose.set(b, knee);
    return;
  }

  const speedMult = Math.min(speed / 5.0, 1.0);
  const phase     = tick * WOLF_TROT_FREQ;
  const swing     = Math.sin(phase);

  const A = WOLF_LEG_AMP * speedMult;
  const K = WOLF_KNEE_AMP * speedMult;

  const bob     = Math.abs(swing) * 0.008 * speedMult;
  const tailWag = swing * 0.15;

  pose.set("body",     new THREE.Euler(-0.04 - bob, 0, 0));
  pose.set("head",     new THREE.Euler(0.05, 0, 0));
  pose.set("tail",     new THREE.Euler(0, tailWag, 0));

  pose.set("fl_upper", new THREE.Euler(-swing * A, 0, 0));
  pose.set("fl_lower", new THREE.Euler(Math.max(0, swing) * K + 0.05, 0, 0));
  pose.set("rr_upper", new THREE.Euler(-swing * A, 0, 0));
  pose.set("rr_lower", new THREE.Euler(Math.max(0, swing) * K + 0.05, 0, 0));
  pose.set("fr_upper", new THREE.Euler(swing * A, 0, 0));
  pose.set("fr_lower", new THREE.Euler(Math.max(0, -swing) * K + 0.05, 0, 0));
  pose.set("rl_upper", new THREE.Euler(swing * A, 0, 0));
  pose.set("rl_lower", new THREE.Euler(Math.max(0, -swing) * K + 0.05, 0, 0));
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
    // blade direction in Three.js local space
    bladeDirX:  pose.bladeDir.right,
    bladeDirY:  pose.bladeDir.up,
    bladeDirZ: -pose.bladeDir.fwd,
  };
}
