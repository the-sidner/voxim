/**
 * Procedural skeleton pose evaluator — layered lower/upper body.
 *
 * Lower body (root, hips, legs) always plays locomotion derived from the
 * entity's velocity relative to its facing direction:
 *   • Idle   — breathing sway, soft knee bend
 *   • Walk   — bipedal gait with direction-aware phase (forward / backward /
 *              strafe); speed derived from velocity magnitude
 *
 * Upper body (torso_mid, torso_upper, head, arms) plays independently:
 *   • Follows locomotion normally when mode is idle/walk
 *   • Overridden by attack / death animations regardless of movement
 *
 * Attack animation is parameterised entirely by the phase data forwarded from
 * the server's AnimationStateData:
 *   windupTicks, activeTicks, winddownTicks, ticksIntoAction
 * No hardcoded timing constants.  attackStyle selects the pose function.
 *
 * Directional walk mapping:
 *   facingAngle is the world-space heading (radians, counter-clockwise from +X).
 *   Velocity (vx, vy) is rotated into local facing space:
 *     localFwd    = -vx·sin(facing) + vy·cos(facing)   ← + = backward
 *     localStrafe =  vx·cos(facing) + vy·sin(facing)   ← + = strafe-right
 *   Backward walk flips the gait phase. Strafe adds lateral arm splay.
 *
 * Bone hierarchy (human):
 *   root → torso_lower → torso_mid → torso_upper → head
 *                                  ↘ upper_arm_l → lower_arm_l
 *                                  ↘ upper_arm_r → lower_arm_r
 *        → upper_leg_l → lower_leg_l
 *        → upper_leg_r → lower_leg_r
 */
import * as THREE from "three";
import type { AnimationMode } from "@voxim/content";

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

const ATTACK_AMP  = 1.6;

/** Below this world-speed the locomotion is treated as idle. */
const WALK_SPEED_THRESHOLD = 0.05;

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
): Map<string, THREE.Euler> {
  const pose = new Map<string, THREE.Euler>();
  if (skeletonId === "human") {
    evaluateHumanPose(pose, mode, attackStyle, windupTicks, activeTicks, winddownTicks, ticksIntoAction, serverTick, velocityX, velocityY, facingAngle);
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
  attackStyle: string,
  windupTicks: number,
  activeTicks: number,
  winddownTicks: number,
  ticksIntoAction: number,
  tick: number,
  vx: number,
  vy: number,
  facing: number,
): void {
  const speed = Math.sqrt(vx * vx + vy * vy);
  const moving = speed > WALK_SPEED_THRESHOLD;
  const [localFwd, localStrafe] = worldVelToLocal(vx, vy, facing);

  lowerBodyLocomotion(pose, tick, moving, localFwd, localStrafe, speed);

  if (mode === "attack") {
    const t = actionT(windupTicks, activeTicks, winddownTicks, ticksIntoAction);
    upperBodyAttack(pose, attackStyle, t);
  } else if (mode === "death") {
    upperBodyDeath(pose);
    lowerBodyDeath(pose);
  } else {
    upperBodyLocomotion(pose, tick, moving, localFwd, localStrafe);
  }
}

// ── lower body ────────────────────────────────────────────────────────────────

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

// ── upper body ────────────────────────────────────────────────────────────────

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

/**
 * Dispatch to the correct attack pose function by style.
 * t ∈ [0,1] spans the full windup→active→winddown arc.
 */
function upperBodyAttack(pose: Map<string, THREE.Euler>, style: string, t: number): void {
  switch (style) {
    case "overhead": return upperBodyOverhead(pose, t);
    case "thrust":   return upperBodyThrust(pose, t);
    case "unarmed":  return upperBodyUnarmed(pose, t);
    case "bite":     break; // no human bone rig for bite
    default:         return upperBodySlash(pose, t); // "slash" and fallback
  }
}

function upperBodySlash(pose: Map<string, THREE.Euler>, t: number): void {
  // Wind-up (0–0.25) → strike (0.25–0.5) → snap back (0.5–1.0)
  const swing = t < 0.25
    ? -(t / 0.25) * (ATTACK_AMP * 0.3)
    : t < 0.5
      ? -(1 - (t - 0.25) / 0.25) * (ATTACK_AMP * 0.3) + ((t - 0.25) / 0.25) * ATTACK_AMP
      : (1 - (t - 0.5) / 0.5) * ATTACK_AMP;
  const twist = swing * 0.25;
  pose.set("torso_mid",   new THREE.Euler(0.05, -twist, 0));
  pose.set("torso_upper", new THREE.Euler(0.08, -twist, 0));
  pose.set("head",        new THREE.Euler(0, -twist * 0.4, 0));
  pose.set("upper_arm_l", new THREE.Euler(-0.3, 0, -0.25));
  pose.set("lower_arm_l", new THREE.Euler(0.5, 0, 0));
  pose.set("upper_arm_r", new THREE.Euler(-swing, 0, 0.15));
  pose.set("lower_arm_r", new THREE.Euler(Math.max(0, swing * 0.4), 0, 0));
}

function upperBodyOverhead(pose: Map<string, THREE.Euler>, t: number): void {
  // Raise both arms (0–0.4) → slam down (0.4–0.6) → recover (0.6–1.0)
  const raise = t < 0.4
    ? (t / 0.4) * ATTACK_AMP * 0.8
    : t < 0.6
      ? ATTACK_AMP * 0.8 - ((t - 0.4) / 0.2) * ATTACK_AMP * 1.4
      : -ATTACK_AMP * 0.6 + ((t - 0.6) / 0.4) * ATTACK_AMP * 0.6;
  pose.set("torso_mid",   new THREE.Euler(-raise * 0.15, 0, 0));
  pose.set("torso_upper", new THREE.Euler(-raise * 0.2, 0, 0));
  pose.set("head",        new THREE.Euler(raise * 0.1, 0, 0));
  pose.set("upper_arm_l", new THREE.Euler(-raise, 0, -0.2));
  pose.set("lower_arm_l", new THREE.Euler(Math.max(0, raise * 0.3), 0, 0));
  pose.set("upper_arm_r", new THREE.Euler(-raise, 0,  0.2));
  pose.set("lower_arm_r", new THREE.Euler(Math.max(0, raise * 0.3), 0, 0));
}

function upperBodyThrust(pose: Map<string, THREE.Euler>, t: number): void {
  // Coil back (0–0.3) → lunge forward (0.3–0.55) → retract (0.55–1.0)
  const reach = t < 0.3
    ? -(t / 0.3) * 0.4
    : t < 0.55
      ? -0.4 + ((t - 0.3) / 0.25) * (ATTACK_AMP * 0.9 + 0.4)
      : ATTACK_AMP * 0.9 - ((t - 0.55) / 0.45) * ATTACK_AMP * 0.9;
  pose.set("torso_mid",   new THREE.Euler(-reach * 0.1, 0, 0));
  pose.set("torso_upper", new THREE.Euler(-reach * 0.15, 0, 0));
  pose.set("head",        new THREE.Euler(reach * 0.05, 0, 0));
  pose.set("upper_arm_l", new THREE.Euler(0.2, 0, -0.3));
  pose.set("lower_arm_l", new THREE.Euler(0.35, 0, 0));
  pose.set("upper_arm_r", new THREE.Euler(-reach, 0, 0.1));
  pose.set("lower_arm_r", new THREE.Euler(Math.max(0, reach * 0.2), 0, 0));
}

function upperBodyUnarmed(pose: Map<string, THREE.Euler>, t: number): void {
  // Quick jab: pull back (0–0.3) → extend (0.3–0.55) → retract (0.55–1.0)
  const jab = t < 0.3
    ? -(t / 0.3) * 0.5
    : t < 0.55
      ? -0.5 + ((t - 0.3) / 0.25) * (ATTACK_AMP * 0.7 + 0.5)
      : ATTACK_AMP * 0.7 - ((t - 0.55) / 0.45) * ATTACK_AMP * 0.7;
  pose.set("torso_mid",   new THREE.Euler(0.03, -jab * 0.15, 0));
  pose.set("torso_upper", new THREE.Euler(0.05, -jab * 0.2, 0));
  pose.set("head",        new THREE.Euler(0, -jab * 0.08, 0));
  pose.set("upper_arm_l", new THREE.Euler(0.15, 0, -0.2));
  pose.set("lower_arm_l", new THREE.Euler(0.3, 0, 0));
  pose.set("upper_arm_r", new THREE.Euler(-jab, 0, 0.12));
  pose.set("lower_arm_r", new THREE.Euler(Math.max(0, jab * 0.25), 0, 0));
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

// ── Wolf (quadruped) ──────────────────────────────────────────────────────────

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
    // Lunge: pull back → snap forward → recover
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
