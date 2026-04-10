/**
 * Procedural pose functions — shared between server (HitboxSystem) and client
 * (skeleton_evaluator.ts wraps these for Three.js rendering).
 *
 * All output is in solver space (x=right, y=up, z=-fwd) as BoneRotation
 * (Euler XYZ intrinsic angles, same convention as THREE.Euler default order).
 * No Three.js types anywhere in this file.
 *
 * Both computeHumanPose and computeWolfPose accept an optional `out` map.
 * If provided it is cleared and reused, avoiding allocation on hot paths.
 */
import type { AnimationMode, SwingKeyframe, IKTargetDef } from "./types.ts";
import type { BoneRotation, Quat } from "./ik_solver.ts";
import { solveTwoBoneIK, quatFromEulerXYZ, quatMultiply, invertQuat, applyQuat } from "./ik_solver.ts";
import { evaluateSwingPath, deriveTip } from "./sweep_math.ts";
import type { Vec3 } from "./sweep_math.ts";

// ---- constants ----

const WALK_FREQ   = 0.25;
const WALK_AMP    = 0.75;
const KNEE_AMP    = 0.55;
const ARM_AMP     = 0.55;
const ELBOW_AMP   = 0.35;

const BREATH_FREQ = 0.08;
const BREATH_AMP  = 0.05;
const SWAY_FREQ   = 0.05;
const SWAY_AMP    = 0.025;

const WALK_SPEED_THRESHOLD = 0.05;

/** Human arm bone length in world units (restZ=2 × scale=0.35). */
const ARM_BONE_LEN = 0.7;

/**
 * Shoulder rest position in solver space (y=up).
 * Accumulated from: root(0) + torso_lower(1.05y) + torso_mid(0.35y) + torso_upper(0.35y) + upper_arm(±0.7x).
 */
const SHOULDER_REST_Y = 1.75;

const CROUCH_HIP_FLEX  = 0.90;
const CROUCH_KNEE_BEND = 1.10;
const CROUCH_TORSO_FWD = 0.35;
const CROUCH_WALK_FREQ = 0.18;
const CROUCH_WALK_AMP  = 0.30;

const WOLF_TROT_FREQ  = 0.28;
const WOLF_LEG_AMP    = 0.65;
const WOLF_KNEE_AMP   = 0.45;
const WOLF_TAIL_FREQ  = 0.15;

const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

// ---- internal constraint type ----

interface PoseConstraint {
  type: "two-bone-ik";
  chain: [string, string];
  target: Vec3;    // solver space
  poleHint: Vec3;  // solver space
}

// ---- helpers ----

function set(pose: Map<string, BoneRotation>, bone: string, x: number, y: number, z: number): void {
  pose.set(bone, { x, y, z });
}

function worldVelToLocal(vx: number, vy: number, facing: number): [number, number] {
  const c = Math.cos(facing), s = Math.sin(facing);
  return [-vx * s + vy * c, vx * c + vy * s];
}

function actionT(windupTicks: number, activeTicks: number, winddownTicks: number, ticksIntoAction: number): number {
  const total = windupTicks + activeTicks + winddownTicks;
  return total > 0 ? Math.min(ticksIntoAction / total, 1.0) : 1.0;
}

// ---- public API ----

export interface HumanWeaponData {
  keyframes: SwingKeyframe[];
  ikTargets?: IKTargetDef[];
  windupTicks: number;
  activeTicks: number;
  winddownTicks: number;
  ticksIntoAction: number;
  bladeLength: number;
}

export interface WolfWeaponData {
  windupTicks: number;
  activeTicks: number;
  winddownTicks: number;
  ticksIntoAction: number;
}

/**
 * Compute bone rotations (Euler XYZ, solver space) for a human skeleton.
 *
 * @param mode         Current animation mode.
 * @param tick         Server tick number (drives gait cycle / breathing).
 * @param vx           World-space velocity X.
 * @param vy           World-space velocity Y.
 * @param facingAngle  World-space heading in radians.
 * @param weaponData   Required when mode === "attack". Ignored otherwise.
 * @param out          Optional output map to reuse (cleared on entry).
 */
export function computeHumanPose(
  mode: AnimationMode,
  tick: number,
  vx: number,
  vy: number,
  facingAngle: number,
  weaponData?: HumanWeaponData,
  out?: Map<string, BoneRotation>,
): Map<string, BoneRotation> {
  const pose: Map<string, BoneRotation> = out ?? new Map();
  if (out) out.clear();

  const speed = Math.sqrt(vx * vx + vy * vy);
  const moving = speed > WALK_SPEED_THRESHOLD;
  const [localFwd, localStrafe] = worldVelToLocal(vx, vy, facingAngle);

  lowerBodyLocomotion(pose, tick, moving, localFwd, localStrafe, speed);

  if (mode === "attack" && weaponData?.keyframes) {
    const t = actionT(weaponData.windupTicks, weaponData.activeTicks, weaponData.winddownTicks, weaponData.ticksIntoAction);
    const constraints = weaponAnimationLayer(pose, t, weaponData.keyframes, weaponData.ikTargets, weaponData.bladeLength);
    solveConstraints(pose, constraints);
  } else if (mode === "death") {
    upperBodyDeath(pose);
    lowerBodyDeath(pose);
  } else if (mode === "crouch" || mode === "crouch_walk") {
    lowerBodyCrouch(pose, tick, moving, localFwd, localStrafe, speed);
    upperBodyCrouch(pose, tick, moving);
  } else {
    upperBodyLocomotion(pose, tick, moving, localFwd, localStrafe);
  }

  return pose;
}

/**
 * Compute bone rotations (Euler XYZ, solver space) for a wolf skeleton.
 */
export function computeWolfPose(
  mode: AnimationMode,
  tick: number,
  vx: number,
  vy: number,
  weaponData?: WolfWeaponData,
  out?: Map<string, BoneRotation>,
): Map<string, BoneRotation> {
  const pose: Map<string, BoneRotation> = out ?? new Map();
  if (out) out.clear();

  const speed  = Math.sqrt(vx * vx + vy * vy);
  const moving = speed > WALK_SPEED_THRESHOLD;

  if (mode === "death") {
    set(pose, "body",     0, 0, Math.PI / 2);
    set(pose, "head",     0.3, 0, 0);
    set(pose, "tail",     0, 0, -0.4);
    set(pose, "fl_upper", 0.2,  0, -0.3);
    set(pose, "fl_lower", 0.15, 0, 0);
    set(pose, "fr_upper", -0.1, 0,  0.25);
    set(pose, "fr_lower", 0.2,  0, 0);
    set(pose, "rl_upper", 0.1,  0, -0.2);
    set(pose, "rl_lower", 0.3,  0, 0);
    set(pose, "rr_upper", -0.2, 0,  0.2);
    set(pose, "rr_lower", 0.1,  0, 0);
    return pose;
  }

  if (mode === "attack" && weaponData) {
    const t = actionT(weaponData.windupTicks, weaponData.activeTicks, weaponData.winddownTicks, weaponData.ticksIntoAction);
    const lunge = t < 0.3
      ? -(t / 0.3) * 0.5
      : t < 0.55
        ? -0.5 + ((t - 0.3) / 0.25) * 0.9
        : 0.4 - ((t - 0.55) / 0.45) * 0.4;
    set(pose, "body", lunge, 0, 0);
    set(pose, "head", -lunge * 0.6 - 0.1, 0, 0);
    set(pose, "tail", 0, 0, 0);
    for (const b of ["fl_upper", "fr_upper", "rl_upper", "rr_upper"]) set(pose, b, 0.08, 0, 0);
    for (const b of ["fl_lower", "fr_lower", "rl_lower", "rr_lower"]) set(pose, b, 0.06, 0, 0);
    return pose;
  }

  if (!moving) {
    const breath  = Math.sin(tick * BREATH_FREQ) * 0.03;
    const tailWag = Math.sin(tick * WOLF_TAIL_FREQ) * 0.18;
    set(pose, "body", breath, 0, 0);
    set(pose, "head", -breath * 0.5, 0, 0);
    set(pose, "tail", 0, tailWag, 0);
    for (const b of ["fl_upper", "fr_upper", "rl_upper", "rr_upper"]) set(pose, b, 0, 0, 0);
    for (const b of ["fl_lower", "fr_lower", "rl_lower", "rr_lower"]) set(pose, b, 0.06, 0, 0);
    return pose;
  }

  const speedMult = Math.min(speed / 5.0, 1.0);
  const phase     = tick * WOLF_TROT_FREQ;
  const swing     = Math.sin(phase);
  const A = WOLF_LEG_AMP * speedMult;
  const K = WOLF_KNEE_AMP * speedMult;
  const bob     = Math.abs(swing) * 0.008 * speedMult;
  const tailWag = swing * 0.15;

  set(pose, "body", -0.04 - bob, 0, 0);
  set(pose, "head", 0.05, 0, 0);
  set(pose, "tail", 0, tailWag, 0);
  set(pose, "fl_upper", -swing * A, 0, 0);
  set(pose, "fl_lower", Math.max(0, swing) * K + 0.05, 0, 0);
  set(pose, "rr_upper", -swing * A, 0, 0);
  set(pose, "rr_lower", Math.max(0, swing) * K + 0.05, 0, 0);
  set(pose, "fr_upper",  swing * A, 0, 0);
  set(pose, "fr_lower", Math.max(0, -swing) * K + 0.05, 0, 0);
  set(pose, "rl_upper",  swing * A, 0, 0);
  set(pose, "rl_lower", Math.max(0, -swing) * K + 0.05, 0, 0);

  return pose;
}

// ---- weapon animation layer (attack mode) ───────────────────────────────────

/**
 * Derives IK constraints from weapon action data. Sets torso/head FK from
 * the hilt position and passive poses for non-constrained arm bones.
 * Returns a list of constraints to be solved generically by solveConstraints.
 */
function weaponAnimationLayer(
  pose: Map<string, BoneRotation>,
  t: number,
  keyframes: SwingKeyframe[],
  ikTargets: IKTargetDef[] | undefined,
  bladeLength: number,
): PoseConstraint[] {
  const swing = evaluateSwingPath(keyframes, t);

  // Torso body language from hilt position (entity-local → solver: x=right, y=up, z=-fwd)
  const torsoTwist = -swing.hilt.right * 0.25;
  const torsoLean  = -(swing.hilt.fwd - 0.2) * 0.08;
  set(pose, "torso_mid",   torsoLean, torsoTwist * 0.7, 0);
  set(pose, "torso_upper", torsoLean * 1.2, torsoTwist, 0);
  set(pose, "head",        0, torsoTwist * 0.3, 0);

  const constraints: PoseConstraint[] = [];
  const constrainedBones = new Set<string>();

  if (ikTargets) {
    for (const ik of ikTargets) {
      const srcLocal = ik.source === "hilt"
        ? swing.hilt
        : deriveTip(swing.hilt, swing.bladeDir, bladeLength);

      // Convert entity-local (right, up, fwd) to solver space (x=right, y=up, z=-fwd)
      const target: Vec3 = { x: srcLocal.right, y: srcLocal.up, z: -srcLocal.fwd };
      const pole: Vec3   = { x: ik.poleHint.right, y: ik.poleHint.up, z: -ik.poleHint.fwd };

      constraints.push({ type: "two-bone-ik", chain: ik.chain as [string, string], target, poleHint: pole });
      constrainedBones.add(ik.chain[0]);
      constrainedBones.add(ik.chain[1]);
    }
  }

  if (!constrainedBones.has("upper_arm_l")) {
    set(pose, "upper_arm_l", 0.08, 0, -0.18);
    set(pose, "lower_arm_l", 0.12, 0, 0);
    set(pose, "hand_l",      0.08, 0, 0);
  }
  if (!constrainedBones.has("upper_arm_r")) {
    set(pose, "upper_arm_r", 0.08, 0, 0.18);
    set(pose, "lower_arm_r", 0.12, 0, 0);
    set(pose, "hand_r",      0.08, 0, 0);
  }

  return constraints;
}

// ---- constraint solver ──────────────────────────────────────────────────────

/** Solve two-bone IK constraints, overwriting arm bone rotations in the pose map. */
function solveConstraints(
  pose: Map<string, BoneRotation>,
  constraints: PoseConstraint[],
): void {
  for (const c of constraints) {
    if (c.type !== "two-bone-ik") continue;

    const isLeft = c.chain[0].endsWith("_l");
    const shoulderX = isLeft ? -ARM_BONE_LEN : ARM_BONE_LEN;

    // Accumulated torso orientation (torso_mid then torso_upper)
    const midRot   = pose.get("torso_mid")   ?? { x: 0, y: 0, z: 0 };
    const upperRot = pose.get("torso_upper") ?? { x: 0, y: 0, z: 0 };
    let torsoQuat: Quat = quatFromEulerXYZ(midRot.x, midRot.y, midRot.z);
    torsoQuat = quatMultiply(torsoQuat, quatFromEulerXYZ(upperRot.x, upperRot.y, upperRot.z));
    const invTorsoQuat = invertQuat(torsoQuat);

    // Shoulder position in solver space after torso rotations
    const shoulderRest: Vec3 = { x: shoulderX, y: SHOULDER_REST_Y, z: 0 };
    const shoulder = applyQuat(shoulderRest, torsoQuat);

    // IK target and pole in shoulder-local space
    const targetRelShoulder: Vec3 = {
      x: c.target.x - shoulder.x,
      y: c.target.y - shoulder.y,
      z: c.target.z - shoulder.z,
    };
    const localTarget = applyQuat(targetRelShoulder, invTorsoQuat);
    const poleLocal   = applyQuat(c.poleHint, invTorsoQuat);

    const result = solveTwoBoneIK(ARM_BONE_LEN, ARM_BONE_LEN, localTarget, poleLocal);
    pose.set(c.chain[0], result.rotA);
    pose.set(c.chain[1], result.rotB);
  }
}

// ---- human lower body ───────────────────────────────────────────────────────

function lowerBodyLocomotion(
  pose: Map<string, BoneRotation>,
  tick: number,
  moving: boolean,
  localFwd: number,
  localStrafe: number,
  speed: number,
): void {
  if (!moving) {
    const sway = Math.sin(tick * SWAY_FREQ) * SWAY_AMP;
    set(pose, "root",        0, 0, 0);
    set(pose, "torso_lower", 0, sway, 0);
    set(pose, "upper_leg_l", 0, 0, 0);
    set(pose, "lower_leg_l", 0.06, 0, 0);
    set(pose, "upper_leg_r", 0, 0, 0);
    set(pose, "lower_leg_r", 0.06, 0, 0);
    set(pose, "foot_l",      0, 0, 0);
    set(pose, "foot_r",      0, 0, 0);
    set(pose, "hand_l",      0.1, 0, 0);
    set(pose, "hand_r",      0.1, 0, 0);
    return;
  }

  const fwdSign   = localFwd >= 0 ? 1 : -1;
  const speedMult = Math.min(speed / 4.0, 1.0);
  const phase     = tick * WALK_FREQ * fwdSign;
  const swing     = Math.sin(phase) * WALK_AMP * speedMult;
  const kneeL     = 0.3 + Math.max(0, -Math.sin(phase)) * KNEE_AMP * speedMult;
  const kneeR     = 0.3 + Math.max(0,  Math.sin(phase)) * KNEE_AMP * speedMult;
  const bob       = Math.abs(Math.sin(phase)) * 0.015;
  const hipLean   = localStrafe * 0.08;

  set(pose, "root",        -0.04 - bob, 0, 0);
  set(pose, "torso_lower", 0.04, swing * 0.12 + hipLean, 0);
  set(pose, "upper_leg_l",  swing, 0, 0);
  set(pose, "lower_leg_l", kneeL, 0, 0);
  set(pose, "upper_leg_r", -swing, 0, 0);
  set(pose, "lower_leg_r", kneeR, 0, 0);
  set(pose, "foot_l",      0, 0, 0);
  set(pose, "foot_r",      0, 0, 0);
  set(pose, "hand_l",      0.1, 0, 0);
  set(pose, "hand_r",      0.1, 0, 0);
}

function lowerBodyDeath(pose: Map<string, BoneRotation>): void {
  set(pose, "root",        0, 0, Math.PI / 2);
  set(pose, "torso_lower", 0, 0, 0);
  set(pose, "upper_leg_l",  0.1,   0, -0.25);
  set(pose, "lower_leg_l",  0.25,  0, 0);
  set(pose, "upper_leg_r", -0.15,  0, 0.2);
  set(pose, "lower_leg_r",  0.15,  0, 0);
}

function lowerBodyCrouch(
  pose: Map<string, BoneRotation>,
  tick: number,
  moving: boolean,
  localFwd: number,
  localStrafe: number,
  speed: number,
): void {
  if (!moving) {
    const sway = Math.sin(tick * SWAY_FREQ) * SWAY_AMP * 0.5;
    set(pose, "root",        -0.08, 0, 0);
    set(pose, "torso_lower", 0, sway, 0);
    set(pose, "upper_leg_l", CROUCH_HIP_FLEX, 0, 0);
    set(pose, "lower_leg_l", CROUCH_KNEE_BEND, 0, 0);
    set(pose, "upper_leg_r", CROUCH_HIP_FLEX, 0, 0);
    set(pose, "lower_leg_r", CROUCH_KNEE_BEND, 0, 0);
    set(pose, "foot_l",      -0.15, 0, 0);
    set(pose, "foot_r",      -0.15, 0, 0);
    set(pose, "hand_l",      0.1, 0, 0);
    set(pose, "hand_r",      0.1, 0, 0);
    return;
  }

  const fwdSign   = localFwd >= 0 ? 1 : -1;
  const speedMult = Math.min(speed / 3.0, 1.0);
  const phase     = tick * CROUCH_WALK_FREQ * fwdSign;
  const swing     = Math.sin(phase) * CROUCH_WALK_AMP * speedMult;
  const hipLean   = localStrafe * 0.06;

  set(pose, "root",        -0.08, 0, 0);
  set(pose, "torso_lower", 0, swing * 0.10 + hipLean, 0);
  set(pose, "upper_leg_l", CROUCH_HIP_FLEX + swing,  0, 0);
  set(pose, "lower_leg_l", CROUCH_KNEE_BEND + Math.max(0, -swing) * 0.25, 0, 0);
  set(pose, "upper_leg_r", CROUCH_HIP_FLEX - swing,  0, 0);
  set(pose, "lower_leg_r", CROUCH_KNEE_BEND + Math.max(0,  swing) * 0.25, 0, 0);
  set(pose, "foot_l",      -0.15, 0, 0);
  set(pose, "foot_r",      -0.15, 0, 0);
  set(pose, "hand_l",      0.1, 0, 0);
  set(pose, "hand_r",      0.1, 0, 0);
}

// ---- human upper body ───────────────────────────────────────────────────────

function upperBodyLocomotion(
  pose: Map<string, BoneRotation>,
  tick: number,
  moving: boolean,
  localFwd: number,
  localStrafe: number,
): void {
  const breath = Math.sin(tick * BREATH_FREQ) * BREATH_AMP;
  const sway   = Math.sin(tick * SWAY_FREQ)   * SWAY_AMP;

  if (!moving) {
    set(pose, "torso_mid",   breath * 0.4, -sway * 0.5, 0);
    set(pose, "torso_upper", breath, sway * 0.3, 0);
    set(pose, "head",        -breath * 0.3, Math.sin(tick * SWAY_FREQ * 0.7) * 0.02, 0);
    set(pose, "upper_arm_l", 0.08, 0, -0.18);
    set(pose, "lower_arm_l", 0.12, 0, 0);
    set(pose, "upper_arm_r", 0.08, 0,  0.18);
    set(pose, "lower_arm_r", 0.12, 0, 0);
    set(pose, "hand_l",      0.08, 0, 0);
    set(pose, "hand_r",      0.08, 0, 0);
    return;
  }

  const fwdSign    = localFwd >= 0 ? 1 : -1;
  const phase      = tick * WALK_FREQ * fwdSign;
  const swing      = Math.sin(phase);
  const armSwing   = swing * ARM_AMP;
  const elbowBend  = 0.25 + Math.abs(swing) * ELBOW_AMP;
  const spineTwist = swing * 0.10;
  const leanFwd    = localFwd    * 0.04;
  const strafeSplay= localStrafe * 0.08;

  set(pose, "torso_mid",   leanFwd + 0.02, -spineTwist * 0.8, 0);
  set(pose, "torso_upper", leanFwd + 0.04, -spineTwist, 0);
  set(pose, "head",        leanFwd * 0.3, swing * 0.04, 0);
  set(pose, "upper_arm_l", -armSwing, 0, -0.12 - strafeSplay);
  set(pose, "lower_arm_l", elbowBend, 0, 0);
  set(pose, "upper_arm_r",  armSwing, 0,  0.12 - strafeSplay);
  set(pose, "lower_arm_r", elbowBend, 0, 0);
  set(pose, "hand_l",      elbowBend * 0.3, 0, 0);
  set(pose, "hand_r",      elbowBend * 0.3, 0, 0);
}

function upperBodyDeath(pose: Map<string, BoneRotation>): void {
  set(pose, "torso_mid",   0, 0, 0);
  set(pose, "torso_upper", 0, 0, 0);
  set(pose, "head",        0, 0, 0.15);
  set(pose, "upper_arm_l", 0.2,  0, -0.9);
  set(pose, "lower_arm_l", 0.4,  0, 0);
  set(pose, "upper_arm_r", -0.1, 0, 0.6);
  set(pose, "lower_arm_r", 0.3,  0, 0);
}

function upperBodyCrouch(
  pose: Map<string, BoneRotation>,
  tick: number,
  moving: boolean,
): void {
  const breath = Math.sin(tick * BREATH_FREQ) * BREATH_AMP * 0.6;
  const sway   = Math.sin(tick * SWAY_FREQ)   * SWAY_AMP   * 0.5;

  set(pose, "torso_mid",   CROUCH_TORSO_FWD + breath * 0.3, -sway * 0.4, 0);
  set(pose, "torso_upper", CROUCH_TORSO_FWD * 0.6 + breath,  sway * 0.2, 0);
  set(pose, "head",        -CROUCH_TORSO_FWD * 0.5 - breath * 0.3, moving ? 0 : Math.sin(tick * SWAY_FREQ * 0.7) * 0.015, 0);
  set(pose, "upper_arm_l", 0.15, 0, -0.22);
  set(pose, "lower_arm_l", 0.20, 0, 0);
  set(pose, "upper_arm_r", 0.15, 0,  0.22);
  set(pose, "lower_arm_r", 0.20, 0, 0);
  set(pose, "hand_l",      0.10, 0, 0);
  set(pose, "hand_r",      0.10, 0, 0);
}
