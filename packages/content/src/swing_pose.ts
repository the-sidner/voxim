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
import type { SkeletonDef, BoneDef, SwingPathDef, SwingKeyframe } from "./types.ts";
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

// ---- the producer ----

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
  //    derived from the hilt, distributed up the three spine joints so it reads
  //    as a spine bending, not a single hinge.
  const restP = solveSkeleton(skeleton, boneIndex, out, scale, morph);
  const yaw = p.twistGain * s.hilt.x;                       // follow hilt laterally
  const lean = p.leanGain * Math.max(0, -s.hilt.z);         // fold toward forward reach
  const D = quatFromEulerXYZ(lean, yaw, 0);                 // world-space spine delta
  const spine: Array<[string, number]> = [["torso_lower", 0.30], ["torso_mid", 0.62], ["torso_upper", 1.0]];
  const spineWorld = new Map<string, Quat>();
  for (const [bid, frac] of spine) {
    const t0 = restP.get(bid); if (!t0) continue;
    const nw = quatMultiply(slerpQuat(IDENT, D, frac), t0.rot);
    const parent = boneIndex.get(bid)?.parent;
    const pnw = (parent && spineWorld.get(parent)) || (parent && restP.get(parent)?.rot) || IDENT;
    out.set(bid, eulerFromQuat(quatMultiply(invertQuat(pnw), nw)));
    spineWorld.set(bid, nw);
  }

  // 2. Re-solve FK with the spine bent, so the shoulder (and arm rest dirs) are
  //    where the torso just put them, then IK the weapon arm onto the hilt.
  const P = solveSkeleton(skeleton, boneIndex, out, scale, morph);
  const handR = p.handBone;
  const lowerR = boneIndex.get(handR)?.parent;
  const upperR = lowerR ? boneIndex.get(lowerR)?.parent : undefined;
  if (upperR && lowerR) {
    const aimWorld = applyQuat(s.bladeDir, IDENT); // bladeDir is already solver-world
    aimLimb(P, boneIndex, upperR, lowerR, handR, hilt, p.poleHint, p.bladeAxisLocal, aimWorld, out);
  }

  // 3. Off-hand counter — bring the free arm to a guard that trails the swing,
  //    so it isn't a dead rest T-pose. A point back + across, lowering as the
  //    swing reaches forward.
  if (p.offHandBone) {
    const handL = p.offHandBone;
    const lowerL = boneIndex.get(handL)?.parent;
    const upperL = lowerL ? boneIndex.get(lowerL)?.parent : undefined;
    if (upperL && lowerL) {
      const reachFwd = Math.max(0, -s.hilt.z);
      const guard = mul({ x: -0.55, y: 3.3 - 0.25 * reachFwd, z: 0.45 + 0.3 * reachFwd }, scale);
      aimLimb(P, boneIndex, upperL, lowerL, handL, guard, { x: -0.4, y: -0.9, z: 0.35 }, null, null, out);
    }
  }

  return out;
}
