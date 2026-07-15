/**
 * Procedural full-body swing pose — the producer that turns an authored
 * `swingPath` (a clean blade arc) into a whole-body motion, so a swing reads as
 * a kinetic chain (hips → spine → shoulder → arm → blade) instead of a clip or
 * a dead body hanging off one IK'd arm.
 *
 * Authored per swing: the blade arc + a few scalars (twist / lean / off-hand
 * gains). Everything else is DERIVED here from the hilt path, every frame:
 *   - spine twist + forward lean follow the hilt (the body turns into the cut)
 *   - the weapon arm is two-bone-IK'd onto the hilt, hand oriented so the blade
 *     points along the authored direction (hit == visual, by construction)
 *   - the off-hand counter-poses to a guard so it isn't a rest T-pose
 *
 * Pure math (no Three.js) — shared by the swing inspector and the client
 * renderer. The server never needs this: its hit sweep reads the swingPath's
 * hilt→tip directly.
 *
 * All vectors are SOLVER space (x=right, y=up, z=-fwd), matching skeleton_solver.
 */
import type { SkeletonDef, BoneDef, SwingPathDef, SwingKeyframe, GripDef, GaitDef, GaitKeyframe } from "./types.ts";
import type { BoneRotation, Quat } from "./ik_solver.ts";
import {
  applyQuat, quatMultiply, invertQuat, eulerFromQuat, quatFromUnitVectors,
  quatFromEulerXYZ, slerpQuat,
} from "./ik_solver.ts";
import { solveSkeleton, type BoneTransform } from "./skeleton_solver.ts";

// ---- small vector helpers (solver space) ----
type V3 = { x: number; y: number; z: number };
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const norm = (a: V3): V3 => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
const IDENT: Quat = { x: 0, y: 0, z: 0, w: 1 };
/** Default off-hand elbow pole (solver space): down, slightly left + back. */
const LEFT_POLE: V3 = { x: -0.4, y: -0.9, z: 0.35 };

/** actor-local {fwd,right,up} → solver {x:right, y:up, z:-fwd}. */
const toSolver = (p: { fwd: number; right: number; up: number }): V3 => ({ x: p.right, y: p.up, z: -p.fwd });

// ---- swing path sampling ----

export interface SwingSample {
  /** Hilt position in actor-local solver space (unscaled). */
  hilt: V3;
  /** Blade pointing direction in solver space (unit). */
  bladeDir: V3;
  /** Blade length (unscaled world units). */
  length: number;
}

/** Sample an authored swingPath at normalised t∈[0,1] → hilt + blade dir (solver). */
export function sampleSwingPath(sp: SwingPathDef, t: number): SwingSample {
  const kf = sp.keyframes;
  let a: SwingKeyframe = kf[0], b: SwingKeyframe = kf[kf.length - 1];
  for (let i = 0; i < kf.length - 1; i++) {
    if (t >= kf[i].t && t <= kf[i + 1].t) { a = kf[i]; b = kf[i + 1]; break; }
  }
  const span = b.t - a.t;
  const f = span > 1e-6 ? (t - a.t) / span : 0;
  const lp = (x: number, y: number) => x + (y - x) * f;
  const hilt = toSolver({ fwd: lp(a.hilt.fwd, b.hilt.fwd), right: lp(a.hilt.right, b.hilt.right), up: lp(a.hilt.up, b.hilt.up) });
  const bladeDir = norm(toSolver({ fwd: lp(a.blade.fwd, b.blade.fwd), right: lp(a.blade.right, b.blade.right), up: lp(a.blade.up, b.blade.up) }));
  return { hilt, bladeDir, length: sp.length };
}

// ---- producer params ----

export interface SwingPoseParams {
  /** Weapon hand bone (default "hand_r") and its arm chain. */
  handBone?: string;
  /** Hand-local axis the blade points along (default +Y, matching the weapon model). */
  bladeAxisLocal?: V3;
  /** Off-hand bone (default "hand_l"); counter-posed to a guard. null disables. */
  offHandBone?: string | null;
  /** Spine twist gain (rad per unit of hilt lateral offset). */
  twistGain?: number;
  /** Spine forward-lean gain (rad per unit of hilt forward reach). */
  leanGain?: number;
  /** Elbow pole hint, solver space (where the weapon elbow bends toward). */
  poleHint?: V3;
  /** Per-entity morph params (body proportions) so the producer's FK matches
   *  the rendered skeleton — pass ModelRef.morphValues on the client. */
  morphParams?: Record<string, number>;
}

const DEFAULTS: Required<Omit<SwingPoseParams, "offHandBone" | "morphParams">> & { offHandBone: string | null } = {
  handBone: "hand_r",
  bladeAxisLocal: { x: 0, y: 1, z: 0 },
  offHandBone: "hand_l",
  twistGain: 0.5,
  leanGain: 0.35,
  poleHint: { x: 0.4, y: -0.9, z: 0.35 }, // down, slightly right + back
};

// ---- two-bone IK in world (solver) space ----

/** Solve elbow + wrist directions for a 2-bone chain rooted at S reaching T. */
function twoBoneDirs(S: V3, T: V3, L1: number, L2: number, pole: V3): { elbowDir: V3; wristDir: V3; elbowPos: V3 } {
  const toT = sub(T, S);
  const dist = len(toT);
  const reach = Math.max(Math.abs(L1 - L2) + 1e-3, Math.min(dist, L1 + L2 - 1e-3));
  const aim = norm(dist < 1e-6 ? { x: 0, y: -1, z: 0 } : toT);
  const cosA = Math.max(-1, Math.min(1, (L1 * L1 + reach * reach - L2 * L2) / (2 * L1 * reach)));
  const angA = Math.acos(cosA);
  let poleDir = sub(pole, mul(aim, dot(pole, aim)));
  if (len(poleDir) < 1e-6) poleDir = sub({ x: 0, y: -1, z: 0 }, mul(aim, dot({ x: 0, y: -1, z: 0 }, aim)));
  poleDir = norm(poleDir);
  const elbowDir = norm(add(mul(aim, Math.cos(angA)), mul(poleDir, Math.sin(angA))));
  const elbowPos = add(S, mul(elbowDir, L1));
  const wristDir = norm(sub(T, elbowPos));
  return { elbowDir, wristDir, elbowPos };
}

/**
 * Aim a 3-bone limb (upper → lower → hand) so the wrist reaches `target` and,
 * optionally, the hand's `bladeAxisLocal` points along `aimWorld`. Writes Euler
 * overrides for the three bones. `P` is the FK result for the current pose
 * (with spine overrides already applied).
 */
function aimLimb(
  P: Map<string, BoneTransform>,
  boneIndex: ReadonlyMap<string, BoneDef>,
  upper: string, lower: string, hand: string,
  target: V3, pole: V3,
  bladeAxisLocal: V3 | null, aimWorld: V3 | null,
  out: Map<string, BoneRotation>,
) {
  const tU = P.get(upper), tL = P.get(lower), tH = P.get(hand);
  if (!tU || !tL || !tH) return;
  const S = tU.pos, E0 = tL.pos, W0 = tH.pos;
  const L1 = len(sub(E0, S)), L2 = len(sub(W0, E0));
  const dU0 = norm(sub(E0, S)), dL0 = norm(sub(W0, E0));

  const { elbowDir, wristDir } = twoBoneDirs(S, target, L1, L2, pole);

  // upper: rotate its rest pointing dir onto elbowDir
  const deltaU = quatFromUnitVectors(dU0, elbowDir);
  const qUnew = quatMultiply(deltaU, tU.rot);
  const parentU = boneIndex.get(upper)?.parent;
  const qParentU = (parentU && P.get(parentU)?.rot) || IDENT;
  out.set(upper, eulerFromQuat(quatMultiply(invertQuat(qParentU), qUnew)));

  // lower: carried by deltaU, then aimed onto wristDir
  const dL1 = applyQuat(dL0, deltaU);
  const deltaL = quatFromUnitVectors(dL1, wristDir);
  const qLnew = quatMultiply(deltaL, quatMultiply(deltaU, tL.rot));
  out.set(lower, eulerFromQuat(quatMultiply(invertQuat(qUnew), qLnew)));

  // hand: carried by deltaL∘deltaU, then (optionally) rolled so the blade aims
  const carry = quatMultiply(deltaL, deltaU);
  let qHnew = quatMultiply(carry, tH.rot);
  if (bladeAxisLocal && aimWorld) {
    const bladeCarried = applyQuat(applyQuat(bladeAxisLocal, tH.rot), carry);
    const deltaH = quatFromUnitVectors(norm(bladeCarried), norm(aimWorld));
    qHnew = quatMultiply(deltaH, qHnew);
  }
  out.set(hand, eulerFromQuat(quatMultiply(invertQuat(qLnew), qHnew)));
}

/**
 * Apply a world-space spine bend (delta quaternion `D`) distributed across the
 * three torso joints so it reads as a spine, not a single hinge. Mutates `pose`
 * in place; reads the CURRENT pose so successive bends compose (a strafe lean
 * then a swing fold stack into one spine). The shared spine primitive for every
 * pose in the catalogue.
 */
function bendSpine(
  skeleton: SkeletonDef,
  boneIndex: ReadonlyMap<string, BoneDef>,
  pose: Map<string, BoneRotation>,
  scale: number,
  D: Quat,
  morph?: Record<string, number>,
) {
  const restP = solveSkeleton(skeleton, boneIndex, pose, scale, morph);
  const spine: Array<[string, number]> = [["torso_lower", 0.30], ["torso_mid", 0.62], ["torso_upper", 1.0]];
  const spineWorld = new Map<string, Quat>();
  for (const [bid, frac] of spine) {
    const t0 = restP.get(bid); if (!t0) continue;
    const nw = quatMultiply(slerpQuat(IDENT, D, frac), t0.rot);
    const parent = boneIndex.get(bid)?.parent;
    const pnw = (parent && spineWorld.get(parent)) || (parent && restP.get(parent)?.rot) || IDENT;
    pose.set(bid, eulerFromQuat(quatMultiply(invertQuat(pnw), nw)));
    spineWorld.set(bid, nw);
  }
}

// ---- locomotion poses (the base-pose catalogue) -----------------------------

/** Movement state that selects/weights base poses. Extends as the catalogue grows. */
export interface LocoState {
  /** Lateral movement relative to facing, -1 (left) … +1 (right). */
  strafe?: number;
  /**
   * Forward/back movement relative to facing, -1 (fully backward) … +1
   * (fully forward). Only a distinct signal from `strafe` once facing
   * decouples from movement direction (T-328's mouse-turn + facing-relative
   * movement) — before that, a moving actor always faces its own movement
   * so this stays ≈+1 and the back-lean below never fires. Absent/0 reads
   * as "not moving forward or back" (pure strafe, or stationary).
   */
  moveFwd?: number;
  /** Turn rate, -1 … +1. */
  turn?: number;
}

export interface LocoPoseParams {
  /** Sideways lean (roll) per unit strafe, radians. */
  strafeLean?: number;
  /** Backward lean (pitch, opposite sign of the swing's forward-reach lean)
   *  per unit backward `moveFwd`, radians — the tell for back-pedalling
   *  while facing a target (T-328). Forward movement adds no lean here (a
   *  purposeful asymmetry: authored walk/run clips already carry forward
   *  lean; this producer only needed to add the state clips can't, going
   *  backward). */
  backLean?: number;
  /** Lean into a turn (roll) per unit turn, radians. */
  turnLean?: number;
  /** Twist into a turn (yaw) per unit turn, radians. */
  turnTwist?: number;
  morphParams?: Record<string, number>;
}

const LOCO_DEFAULTS = { strafeLean: 0.35, backLean: 0.28, turnLean: 0.22, turnTwist: 0.30 };

/**
 * First entry in the base-pose catalogue: a procedural locomotion lean. The
 * body banks into a strafe, folds back when back-pedalling, and leans+twists
 * into a turn — derived from movement state relative to facing, no clip.
 * Returns a new pose; feed it as the `basePose` to `solveSwingPose` and the
 * swing composes on top.
 */
export function applyLocomotionPose(
  skeleton: SkeletonDef,
  boneIndex: ReadonlyMap<string, BoneDef>,
  basePose: ReadonlyMap<string, BoneRotation>,
  scale: number,
  loco: LocoState,
  params: LocoPoseParams = {},
): Map<string, BoneRotation> {
  const out = new Map<string, BoneRotation>(basePose);
  const strafe = loco.strafe ?? 0, turn = loco.turn ?? 0, moveFwd = loco.moveFwd ?? 0;
  const back = Math.max(0, -moveFwd); // 0 (idle/strafe/forward) … 1 (fully backward)
  if (strafe === 0 && turn === 0 && back === 0) return out;
  const lp = { ...LOCO_DEFAULTS, ...params };
  const roll = lp.strafeLean * strafe + lp.turnLean * turn; // sideways bank
  const yaw = lp.turnTwist * turn;                          // twist into the turn
  const lean = -lp.backLean * back;                         // fold back, opposite of the swing's forward fold
  bendSpine(skeleton, boneIndex, out, scale, quatFromEulerXYZ(lean, yaw, roll), params.morphParams);
  return out;
}

export interface CrouchPoseParams {
  /** Knee pole hint, actor-local {fwd,right,up} — knees bend forward. */
  kneePole?: { fwd: number; right: number; up: number };
  /** Foot bones whose legs get planted. Default ["foot_l","foot_r"]. */
  feetBones?: [string, string];
  morphParams?: Record<string, number>;
}

const CROUCH_DEFAULTS = {
  kneePole: { fwd: 1, right: 0, up: -0.2 },
  feetBones: ["foot_l", "foot_r"] as [string, string],
};

/**
 * Crouch: the pelvis drops by `dropY` (scaled solver units) while the feet stay
 * planted — knees bend out. The drop itself is a root translation the CALLER
 * applies (render translates the root group by -dropY; the inspector passes
 * rootOffset to solveSkeleton). This only solves the LEG rotations that re-plant
 * the feet, reusing the same `aimLimb` primitive as the arms. Composes with
 * everything: crouch + strafe + swing stack on one skeleton.
 */
export function applyCrouchPose(
  skeleton: SkeletonDef,
  boneIndex: ReadonlyMap<string, BoneDef>,
  basePose: ReadonlyMap<string, BoneRotation>,
  scale: number,
  dropY: number,
  params: CrouchPoseParams = {},
): Map<string, BoneRotation> {
  const out = new Map<string, BoneRotation>(basePose);
  if (dropY <= 1e-4) return out;
  const morph = params.morphParams;
  const cp = { ...CROUCH_DEFAULTS, ...params };
  // Ground foot targets from the un-dropped pose; hips from the dropped pose.
  const P0 = solveSkeleton(skeleton, boneIndex, out, scale, morph);
  const Pd = solveSkeleton(skeleton, boneIndex, out, scale, morph, undefined, { x: 0, y: -dropY, z: 0 });
  const pole = toSolver(cp.kneePole);
  for (const foot of cp.feetBones) {
    const lower = boneIndex.get(foot)?.parent;
    const upper = lower ? boneIndex.get(lower)?.parent : undefined;
    const target = P0.get(foot)?.pos;
    if (!upper || !lower || !target) continue;
    aimLimb(Pd, boneIndex, upper, lower, foot, target, pole, null, null, out);
  }
  return out;
}

// ---- procedural gait (T-308) -------------------------------------------

export interface GaitPoseParams {
  /** Foot bones to place. Default from the GaitDef, else ["foot_l","foot_r"]. */
  feetBones?: [string, string];
  /** Knee pole hint, actor-local {fwd,right,up}. Default from the GaitDef. */
  kneePole?: { fwd: number; right: number; up: number };
  /**
   * Same shape as `applyCrouchPose`'s implicit drop: when the entity is ALSO
   * crouching, pass the pelvis-drop translation here so the gait's leg IK
   * reaches from the CURRENT (dropped) hip toward the SAME ground-anchored
   * foot targets it would use standing — crouch + walk compose without
   * either producer needing to run first (see swing_pose.test.ts).
   */
  rootOffset?: { x: number; y: number; z: number };
  morphParams?: Record<string, number>;
}

/** Sample a GaitKeyframe track at normalised phase p∈[0,1) (wraps). Linear
 *  interpolation between authored keyframes, matching `sampleSwingPath`. */
function sampleGaitTrack(track: GaitKeyframe[], phase: number): { fwd: number; right: number; up: number } {
  if (track.length === 1) return { fwd: track[0].fwd, right: track[0].right, up: track[0].up };
  const p = ((phase % 1) + 1) % 1;
  let a = track[0], b = track[track.length - 1];
  for (let i = 0; i < track.length - 1; i++) {
    if (p >= track[i].phase && p <= track[i + 1].phase) { a = track[i]; b = track[i + 1]; break; }
  }
  const span = b.phase - a.phase;
  const f = span > 1e-6 ? (p - a.phase) / span : 0;
  const lp = (x: number, y: number) => x + (y - x) * f;
  return { fwd: lp(a.fwd, b.fwd), right: lp(a.right, b.right), up: lp(a.up, b.up) };
}

/**
 * Derive the backward-walk track from `forward` (single-source-of-truth, the
 * same doctrine `deriveTip()` uses for blade tips): a foot planted while
 * walking BACKWARD sweeps from behind to in front instead of front to back,
 * so only the fore/aft (`fwd`) component flips sign; lift (`up`) and stance
 * width (`right`) are unchanged.
 */
function mirrorGaitBackward(forward: GaitKeyframe[]): GaitKeyframe[] {
  return forward.map((k) => ({ phase: k.phase, fwd: -k.fwd, right: k.right, up: k.up }));
}

/**
 * Derive a rightward-strafe track from `forward`: the fore/aft sweep becomes
 * a lateral sweep (the foot steps sideways through the same contact →
 * push-off → lift shape instead of front-to-back). `applyGaitPose` flips the
 * sign for a leftward strafe.
 */
function mirrorGaitStrafe(forward: GaitKeyframe[]): GaitKeyframe[] {
  return forward.map((k) => ({ phase: k.phase, fwd: 0, right: k.fwd, up: k.up }));
}

/**
 * Procedural walk cycle — the base-pose catalogue's gait entry (T-308,
 * Overgrowth-style: a SMALL authored key-pose set, interpolated, not a
 * baked clip). Replaces the locomotion clip's LEG placement; the clip's
 * upper-body pose (arms/spine/head, still evaluated into `basePose` by the
 * caller) is untouched — this only writes the leg IK chains + feet, so each
 * weapon's authored upper-body character survives.
 *
 * `phase` MUST be driven by ground distance travelled (`(distanceTravelled
 * / gait.strideLength) % 1`), not elapsed time — that is what keeps foot
 * speed matched to ground speed at any movement speed instead of sliding.
 * The caller (the renderer) owns that accumulator; this function is pure.
 *
 * Direction blending: `loco.moveFwd`/`loco.strafe` weight the forward /
 * (derived) backward / (derived) strafe tracks. This is an exact
 * no-footslide guarantee ONLY along the three cardinal blends (pure
 * forward, pure backward, pure strafe) — see swing_pose.test.ts. A diagonal
 * movement blends the three tracks linearly, the same informal-blend idiom
 * `applyLocomotionPose` already uses for simultaneous strafe+turn; it reads
 * fine but isn't a proven zero-slide guarantee at every angle.
 */
export function applyGaitPose(
  skeleton: SkeletonDef,
  boneIndex: ReadonlyMap<string, BoneDef>,
  basePose: ReadonlyMap<string, BoneRotation>,
  scale: number,
  gait: GaitDef,
  phase: number,
  loco: LocoState,
  params: GaitPoseParams = {},
): Map<string, BoneRotation> {
  const out = new Map<string, BoneRotation>(basePose);
  const strafe = loco.strafe ?? 0, moveFwd = loco.moveFwd ?? 0;
  const mag = Math.min(1, Math.hypot(strafe, moveFwd));
  if (mag < 1e-3) return out;

  const feetBones = params.feetBones ?? gait.feetBones ?? ["foot_l", "foot_r"];
  const kneePole = params.kneePole ?? gait.kneePole ?? { fwd: 1, right: 0, up: -0.2 };
  const morph = params.morphParams;

  const wFwd = Math.max(0, moveFwd), wBack = Math.max(0, -moveFwd), wStrafe = Math.abs(strafe);
  const total = wFwd + wBack + wStrafe || 1;
  const fFwd = wFwd / total, fBack = wBack / total, fStrafe = wStrafe / total;
  const strafeSign = strafe < 0 ? -1 : 1;

  const backward = gait.backward ?? mirrorGaitBackward(gait.forward);
  const strafeTrack = gait.strafe ?? mirrorGaitStrafe(gait.forward);

  const blended = (p: number): { fwd: number; right: number; up: number } => {
    const f = sampleGaitTrack(gait.forward, p);
    const b = sampleGaitTrack(backward, p);
    const s = sampleGaitTrack(strafeTrack, p);
    return {
      fwd:   mag * (fFwd * f.fwd + fBack * b.fwd + fStrafe * s.fwd),
      right: mag * (fFwd * f.right + fBack * b.right + fStrafe * strafeSign * s.right),
      up:    mag * (fFwd * f.up + fBack * b.up + fStrafe * s.up),
    };
  };

  // P0: ground-anchored reference (no rootOffset) — where each foot's rest
  // position sits when standing. Pd: the CURRENT hip position (dropped if
  // rootOffset/crouching), which is what aimLimb reaches its IK chain from.
  // Targets are computed from P0 so a crouching walker's feet stay planted
  // at the same ground spot a standing walker's would, exactly mirroring
  // applyCrouchPose's own P0/Pd split.
  const P0 = solveSkeleton(skeleton, boneIndex, out, scale, morph);
  const Pd = params.rootOffset ? solveSkeleton(skeleton, boneIndex, out, scale, morph, undefined, params.rootOffset) : P0;
  const pole = toSolver(kneePole);
  const [footA, footB] = feetBones;
  const samples: Array<[string, number]> = [[footA, phase], [footB, (phase + 0.5) % 1]];
  for (const [foot, p] of samples) {
    const lower = boneIndex.get(foot)?.parent;
    const upper = lower ? boneIndex.get(lower)?.parent : undefined;
    const rest = P0.get(foot)?.pos;
    if (!upper || !lower || !rest) continue;
    const delta = mul(toSolver(blended(p)), scale);
    const target = add(rest, delta);
    aimLimb(Pd, boneIndex, upper, lower, foot, target, pole, null, null, out);
  }
  return out;
}

export interface FootTerrainParams {
  /** Knee pole hint, actor-local {fwd,right,up} — knees bend forward. */
  kneePole?: { fwd: number; right: number; up: number };
  /** Foot bones to plant. Default ["foot_l","foot_r"]. */
  feetBones?: [string, string];
  /**
   * Clamp on the per-foot vertical adjustment (unscaled world units, scaled
   * by `scale` before use). Guards against `ClientWorld.getTerrainHeight`'s
   * documented unloaded-chunk-returns-0 artifact turning into a wild leg
   * stretch at the tile edge — a bounded, known limitation, not a bug this
   * producer can fix (see client_world.ts).
   */
  maxOffset?: number;
  morphParams?: Record<string, number>;
}

const FOOT_TERRAIN_DEFAULTS = {
  kneePole: { fwd: 1, right: 0, up: -0.2 },
  feetBones: ["foot_l", "foot_r"] as [string, string],
  maxOffset: 0.5,
};

/**
 * Plant each foot at the LOCAL terrain height under it instead of the flat-
 * ground assumption baked into the rest pose, so feet read as touching a
 * slope/step instead of floating or clipping. The root is already glued to
 * the terrain height under the entity's own centre (physics/interpolation
 * keep it there), so each foot only needs the DELTA between the ground
 * sampled under IT and the ground sampled under the root — both samples go
 * through the same `heightAt`, so this is self-consistent (degrades to a
 * no-op on flat ground) rather than chasing the entity's actual, possibly
 * airborne, world Z. Reuses `aimLimb`, the same primitive `applyCrouchPose`
 * re-plants feet with — this IS T-186's "foot IK pass … so feet stay
 * planted on terrain" aux item, built once and shared with T-308.
 *
 * `root`/`facing` are WORLD ground-plane coordinates (x,y) + radians, the
 * wire's convention — forward = (cos(facing), sin(facing)), right =
 * forward rotated -90° — matching `combat.ts`'s movement-intent vector and
 * this file's own strafe/moveFwd projection in the client's `locoState()`.
 * Callers pass the entity's networked/predicted world position, NEVER
 * Three.js `group.position`/`rotation.y` (different axes, different frame).
 */
export function applyFootTerrainIK(
  skeleton: SkeletonDef,
  boneIndex: ReadonlyMap<string, BoneDef>,
  basePose: ReadonlyMap<string, BoneRotation>,
  scale: number,
  root: { x: number; y: number },
  facing: number,
  heightAt: (worldX: number, worldY: number) => number,
  params: FootTerrainParams = {},
): Map<string, BoneRotation> {
  const out = new Map<string, BoneRotation>(basePose);
  const fp = { ...FOOT_TERRAIN_DEFAULTS, ...params };
  const morph = params.morphParams;
  const P0 = solveSkeleton(skeleton, boneIndex, out, scale, morph);
  const pole = toSolver(fp.kneePole);
  const cosF = Math.cos(facing), sinF = Math.sin(facing);
  const rootGround = heightAt(root.x, root.y);
  const clamp = fp.maxOffset * scale;
  for (const foot of fp.feetBones) {
    const lower = boneIndex.get(foot)?.parent;
    const upper = lower ? boneIndex.get(lower)?.parent : undefined;
    const rest = P0.get(foot)?.pos;
    if (!upper || !lower || !rest) continue;
    const fwd = -rest.z, right = rest.x; // solver space (x=right,y=up,z=-fwd) → actor-local fwd/right
    const worldX = root.x + fwd * cosF + right * sinF;
    const worldY = root.y + fwd * sinF - right * cosF;
    let dy = heightAt(worldX, worldY) - rootGround;
    dy = Math.max(-clamp, Math.min(clamp, dy));
    if (Math.abs(dy) < 1e-4) continue;
    const target = { x: rest.x, y: rest.y + dy, z: rest.z };
    aimLimb(P0, boneIndex, upper, lower, foot, target, pole, null, null, out);
  }
  return out;
}

/**
 * Head/gaze stabilization — the base-pose catalogue's "look-at": the head
 * counter-rotates against whatever lean the spine has accumulated (strafe
 * bank, back-pedal fold, turn twist, crouch) so the character keeps reading
 * as looking where it's facing instead of its head lolling with the body.
 * `gain` blends the head's world orientation from "fully follows the body"
 * (0) to "fully level/forward, cancelling all upstream lean" (1); a partial
 * gain (default) keeps some organic follow-through instead of a rigid neck.
 *
 * This is NOT target-tracking (aiming at a specific nearby entity/POI) —
 * that needs a look-target signal the wire doesn't carry yet. What's here
 * is the data-free baseline every target-tracking look-at would sit on top
 * of: the head stays aimed at the character's OWN facing regardless of how
 * the torso is currently leaning.
 */
export function applyLookAtPose(
  skeleton: SkeletonDef,
  boneIndex: ReadonlyMap<string, BoneDef>,
  basePose: ReadonlyMap<string, BoneRotation>,
  scale: number,
  gain: number,
  params: { headBone?: string; morphParams?: Record<string, number> } = {},
): Map<string, BoneRotation> {
  const out = new Map<string, BoneRotation>(basePose);
  const g = Math.max(0, Math.min(1, gain));
  if (g <= 0) return out;
  const head = params.headBone ?? "head";
  const morph = params.morphParams;
  const parent = boneIndex.get(head)?.parent;
  if (!parent) return out;
  const P = solveSkeleton(skeleton, boneIndex, out, scale, morph);
  const REST = solveSkeleton(skeleton, boneIndex, new Map(), scale, morph);
  const cur = P.get(head), rest = REST.get(head), curParent = P.get(parent);
  if (!cur || !rest || !curParent) return out;
  const target = slerpQuat(cur.rot, rest.rot, g);
  out.set(head, eulerFromQuat(quatMultiply(invertQuat(curParent.rot), target)));
  return out;
}

// ---- the swing producer ----

/**
 * Build the full-body override rotations for a swing in progress.
 *
 * @param basePose  Locomotion / idle bone rotations to build on (the lower body
 *                  and any non-overridden bones keep these).
 * @param scale     Entity scale (authored hilt units are scale-1; multiplied in).
 * @returns A new rotation map = basePose + spine + both arms.
 */
export function solveSwingPose(
  skeleton: SkeletonDef,
  boneIndex: ReadonlyMap<string, BoneDef>,
  basePose: ReadonlyMap<string, BoneRotation>,
  scale: number,
  sp: SwingPathDef,
  t: number,
  params: SwingPoseParams = {},
): Map<string, BoneRotation> {
  const p = { ...DEFAULTS, ...params };
  const morph = params.morphParams;
  const out = new Map<string, BoneRotation>(basePose);
  const s = sampleSwingPath(sp, t);
  const hilt = mul(s.hilt, scale);

  // 1. Spine producer — twist (yaw about up) + forward lean (pitch about right),
  //    derived from the hilt. Composes on top of whatever the base pose already
  //    bent the spine to (e.g. a strafe lean), so locomotion + swing multiply.
  const yaw = p.twistGain * s.hilt.x;                       // follow hilt laterally
  const lean = p.leanGain * Math.max(0, -s.hilt.z);         // fold toward forward reach
  bendSpine(skeleton, boneIndex, out, scale, quatFromEulerXYZ(lean, yaw, 0), morph);

  // 2. Re-solve FK with the spine bent, so the shoulder (and arm rest dirs) are
  //    where the torso put them, then IK each gripping arm onto its grip point.
  //    ONE primitive (aimLimb) drives every hand — 1H grips the hilt; a 2H off
  //    hand grips a point further down the same blade axis. Default (no authored
  //    grips) = today's 1H: right hand on the hilt, driving the blade.
  const P = solveSkeleton(skeleton, boneIndex, out, scale, morph);
  const grips: GripDef[] = sp.grips ?? [{ bone: p.handBone, along: 0, drivesBlade: true }];
  const gripped = new Set(grips.map((g) => g.bone));
  for (const g of grips) {
    const lower = boneIndex.get(g.bone)?.parent;
    const upper = lower ? boneIndex.get(lower)?.parent : undefined;
    if (!upper || !lower) continue;
    const target = add(hilt, mul(s.bladeDir, g.along * s.length * scale));
    const pole = g.poleHint ? toSolver(g.poleHint) : (g.bone === p.handBone ? p.poleHint : LEFT_POLE);
    const bladeAxis = g.drivesBlade ? p.bladeAxisLocal : null;
    const aimWorld = g.drivesBlade ? s.bladeDir : null;
    aimLimb(P, boneIndex, upper, lower, g.bone, target, pole, bladeAxis, aimWorld, out);
  }

  // 3. Off-hand counter — if the off hand isn't gripping (the 1H case), bring it
  //    to a guard that trails the swing, so it isn't a dead rest T-pose.
  if (p.offHandBone && !gripped.has(p.offHandBone)) {
    const handL = p.offHandBone;
    const lowerL = boneIndex.get(handL)?.parent;
    const upperL = lowerL ? boneIndex.get(lowerL)?.parent : undefined;
    if (upperL && lowerL) {
      const reachFwd = Math.max(0, -s.hilt.z);
      const guard = mul({ x: -0.55, y: 3.3 - 0.25 * reachFwd, z: 0.45 + 0.3 * reachFwd }, scale);
      aimLimb(P, boneIndex, upperL, lowerL, handL, guard, LEFT_POLE, null, null, out);
    }
  }

  return out;
}
