/**
 * Generic two-bone IK solver — pure math, no dependencies.
 *
 * Solves for rotations of two bones (e.g., upper arm → lower arm) such that the
 * end-effector (child of the second bone) reaches a target position.
 *
 * Works in the parent space of the first bone. Rest-pose assumption: each bone's
 * child joint is at (0, -boneLen, 0) in solver space (straight down along -Y).
 * This matches the human skeleton where arms hang vertically in rest pose.
 *
 * Coordinate convention: x = right, y = up, z = -fwd. This is Three.js local space.
 * Callers in entity-local (fwd, right, up) space must convert before calling:
 *   entity-local → solver: { x: right, y: up, z: -fwd }
 *   solver → entity-local: { fwd: -z, right: x, up: y }
 */
import type { Vec3 } from "./sweep_math.ts";

/** Euler rotation angles in radians, XYZ intrinsic order (same as THREE.Euler default). */
export interface BoneRotation {
  x: number;
  y: number;
  z: number;
}

type Quat = { x: number; y: number; z: number; w: number };

// ---- internal math helpers ----

function len(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function norm(v: Vec3): Vec3 {
  const l = len(v);
  if (l < 1e-12) return { x: 0, y: 0, z: 0 };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function addScaled(v: Vec3, other: Vec3, s: number): Vec3 {
  return { x: v.x + other.x * s, y: v.y + other.y * s, z: v.z + other.z * s };
}

function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/** Rotate vector v by unit quaternion q. */
function applyQuat(v: Vec3, q: Quat): Vec3 {
  const ix =  q.w * v.x + q.y * v.z - q.z * v.y;
  const iy =  q.w * v.y + q.z * v.x - q.x * v.z;
  const iz =  q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * (-q.x) + iy * (-q.z) - iz * (-q.y),
    y: iy * q.w + iw * (-q.y) + iz * (-q.x) - ix * (-q.z),
    z: iz * q.w + iw * (-q.z) + ix * (-q.y) - iy * (-q.x),
  };
}

/** Inverse (conjugate) of a unit quaternion. */
export function invertQuat(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/**
 * Quaternion that rotates unit vector `from` onto unit vector `to`.
 * Half-vector method — numerically stable for all angles except exactly 180°.
 */
function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  const d = dot(from, to);
  if (d >= 1.0 - 1e-10) return { x: 0, y: 0, z: 0, w: 1 };
  if (d <= -1.0 + 1e-10) {
    // 180° rotation — find any perpendicular axis
    let perp: Vec3 = { x: 1, y: 0, z: 0 };
    if (Math.abs(from.x) > 0.9) perp = { x: 0, y: 1, z: 0 };
    const c = norm(cross(from, perp));
    return { x: c.x, y: c.y, z: c.z, w: 0 };
  }
  const half = norm({ x: from.x + to.x, y: from.y + to.y, z: from.z + to.z });
  const c = cross(from, half);
  return { x: c.x, y: c.y, z: c.z, w: dot(from, half) };
}

/**
 * Convert unit quaternion to Euler XYZ intrinsic angles.
 * Matches THREE.Euler default order.
 */
function eulerFromQuat(q: Quat): BoneRotation {
  const x2 = q.x * 2, y2 = q.y * 2, z2 = q.z * 2;
  const xx = q.x * x2, xy = q.x * y2, xz = q.x * z2;
  const yy = q.y * y2, yz = q.y * z2, zz = q.z * z2;
  const wx = q.w * x2, wy = q.w * y2, wz = q.w * z2;
  // Rotation matrix element m13 (row 1, col 3) = xz + wy
  const m13 = xz + wy;
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) {
    return {
      x: Math.atan2(-(yz - wx), 1 - (xx + yy)),
      y: ey,
      z: Math.atan2(-(xy - wz), 1 - (yy + zz)),
    };
  }
  // Gimbal lock
  return {
    x: Math.atan2(xy + wz, 1 - (xx + zz)),
    y: ey,
    z: 0,
  };
}

// ---- public API ----

/**
 * Solve a two-bone IK chain.
 *
 * All vectors are in the parent space of bone A.
 * Rest-pose: each bone's child joint is at (0, -boneLen, 0) — straight down (-Y).
 *
 * @param boneALen  Length of bone A (shoulder → elbow)
 * @param boneBLen  Length of bone B (elbow → wrist)
 * @param target    Target world position for the end-effector, in bone-A parent space
 * @param poleHint  Direction the middle joint should bend toward
 * @returns Euler XYZ rotations for bone A and bone B
 */
export function solveTwoBoneIK(
  boneALen: number,
  boneBLen: number,
  target: Vec3,
  poleHint: Vec3,
): { rotA: BoneRotation; rotB: BoneRotation } {
  const dist = len(target);

  // Clamp to reachable range
  const maxReach = boneALen + boneBLen - 0.001;
  const minReach = Math.abs(boneALen - boneBLen) + 0.001;
  const d = Math.max(minReach, Math.min(dist, maxReach));

  // Law of cosines: angle at the shoulder (bone A)
  const cosA = (boneALen * boneALen + d * d - boneBLen * boneBLen) / (2 * boneALen * d);
  const angleA = Math.acos(Math.max(-1, Math.min(1, cosA)));

  // Law of cosines: angle at the elbow (bone B)
  const cosB = (boneALen * boneALen + boneBLen * boneBLen - d * d) / (2 * boneALen * boneBLen);
  const angleB = Math.acos(Math.max(-1, Math.min(1, cosB)));
  void angleB; // used implicitly via the wristDir calculation below

  // aimDir: normalised direction toward target
  let aimDir: Vec3 = norm(dist < 1e-8 ? { x: 0, y: -1, z: 0 } : target);

  // poleDir: component of poleHint perpendicular to aimDir
  let poleDir: Vec3 = addScaled(poleHint, aimDir, -dot(poleHint, aimDir));
  if (len(poleDir) < 1e-8) {
    // Pole hint is parallel to aim — pick an arbitrary perpendicular
    const arb: Vec3 = Math.abs(aimDir.x) > 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    poleDir = addScaled(arb, aimDir, -dot(arb, aimDir));
    if (len(poleDir) < 1e-8) poleDir = { x: 0, y: 0, z: 1 };
  }
  poleDir = norm(poleDir);

  // elbowDir = cos(angleA) * aimDir + sin(angleA) * poleDir
  const sinA = Math.sin(angleA);
  const elbowDir = norm(addScaled(scale(aimDir, Math.cos(angleA)), poleDir, sinA));

  // Bone A rotation: from rest (0, -1, 0) to elbowDir
  const restDown: Vec3 = { x: 0, y: -1, z: 0 };
  const qA = quatFromUnitVectors(restDown, elbowDir);
  const rotA = eulerFromQuat(qA);

  // Bone B: wristDir in parent space
  const elbowPos = scale(elbowDir, boneALen);
  let wristDir: Vec3 = sub(dist < 1e-8 ? scale(aimDir, boneALen + boneBLen) : target, elbowPos);
  if (len(wristDir) < 1e-8) wristDir = { x: 0, y: -1, z: 0 };
  wristDir = norm(wristDir);

  // Transform wristDir into bone B local space (undo bone A rotation)
  const wristLocal = norm(applyQuat(wristDir, invertQuat(qA)));

  // Bone B rotation: from rest (0, -1, 0) to wristLocal
  const qB = quatFromUnitVectors(restDown, wristLocal);
  const rotB = eulerFromQuat(qB);

  return { rotA, rotB };
}

/**
 * Convert Euler XYZ angles to a unit quaternion.
 * Inverse of eulerFromQuat — useful for applying a BoneRotation to a direction.
 */
export function quatFromEulerXYZ(x: number, y: number, z: number): Quat {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

/** Multiply two unit quaternions: result represents applying b after a. */
export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x:  a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y:  a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z:  a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w:  a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export { applyQuat };
export type { Quat };
