/**
 * Generic two-bone IK solver.
 *
 * Solves for rotations of two bones (e.g., upper arm → lower arm) such that the
 * end-effector (child of the second bone) reaches a target position.
 *
 * Works in the parent space of the first bone. Rest-pose assumption: each bone's
 * child joint is at (0, -boneLen, 0) in local Three.js space (straight down).
 * This matches the human skeleton where arms hang vertically in rest pose.
 *
 * The solver is generic — it knows nothing about weapons, hands, or attacks.
 * Any two-bone chain (arms, legs, etc.) can be solved with this function.
 */
import * as THREE from "three";

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();

/**
 * Solve a two-bone IK chain.
 *
 * @param boneALen  Length of first bone (shoulder → elbow)
 * @param boneBLen  Length of second bone (elbow → wrist)
 * @param target    Target position for the end-effector, in the parent space of bone A
 * @param poleHint  Direction the middle joint should bend toward (not necessarily normalized)
 * @returns Euler rotations for bone A and bone B
 */
export function solveTwoBoneIK(
  boneALen: number,
  boneBLen: number,
  target: THREE.Vector3,
  poleHint: THREE.Vector3,
): { rotA: THREE.Euler; rotB: THREE.Euler } {
  const dist = target.length();

  // Clamp to reachable range
  const maxReach = boneALen + boneBLen - 0.001;
  const minReach = Math.abs(boneALen - boneBLen) + 0.001;
  const d = Math.max(minReach, Math.min(dist, maxReach));

  // Law of cosines: angle at the shoulder (bone A)
  // cos(angleA) = (a² + d² - b²) / (2·a·d)
  const cosA = (boneALen * boneALen + d * d - boneBLen * boneBLen) / (2 * boneALen * d);
  const angleA = Math.acos(Math.max(-1, Math.min(1, cosA)));

  // Law of cosines: angle at the elbow (bone B)
  // cos(angleB) = (a² + b² - d²) / (2·a·b)
  const cosB = (boneALen * boneALen + boneBLen * boneBLen - d * d) / (2 * boneALen * boneBLen);
  const angleB = Math.acos(Math.max(-1, Math.min(1, cosB)));

  // Build the arm plane from target direction and pole hint.
  // aimDir: normalized direction from bone A origin toward target
  _v0.copy(target);
  if (_v0.lengthSq() < 1e-8) _v0.set(0, -1, 0);
  _v0.normalize(); // aimDir

  // poleDir: component of poleHint perpendicular to aimDir
  _v1.copy(poleHint);
  _v1.addScaledVector(_v0, -_v1.dot(_v0));
  if (_v1.lengthSq() < 1e-8) {
    // Pole hint is parallel to aim — pick an arbitrary perpendicular
    _v1.set(1, 0, 0);
    _v1.addScaledVector(_v0, -_v1.dot(_v0));
    if (_v1.lengthSq() < 1e-8) _v1.set(0, 0, 1);
  }
  _v1.normalize(); // poleDir (perpendicular to aimDir)

  // Rest pose direction: bone A's child is at (0, -1, 0) local.
  // Bone A rotation aims from (0,-1,0) toward the target, offset by shoulderAngle
  // in the aim-pole plane.
  //
  // The elbow position = boneA origin + boneALen in the direction
  // rotated from aimDir toward poleDir by angleA.
  // elbowDir = cos(angleA) * aimDir + sin(angleA) * poleDir
  const sinA = Math.sin(angleA);
  _v2.copy(_v0).multiplyScalar(Math.cos(angleA)).addScaledVector(_v1, sinA);
  // _v2 is now the direction from shoulder to elbow (in parent space)

  // Bone A rotation: rotate rest-direction (0, -1, 0) to elbowDir
  const restDir = new THREE.Vector3(0, -1, 0);
  _q0.setFromUnitVectors(restDir, _v2);
  const rotA = new THREE.Euler().setFromQuaternion(_q0);

  // Bone B: the remaining rotation at the elbow.
  // In bone B's local space (after bone A rotation), the rest direction is (0, -1, 0).
  // The desired direction goes from elbow toward the target.
  // wristDir (in parent space) = targetPos - elbowPos, normalized
  const elbowPos = _v2.clone().multiplyScalar(boneALen);
  const wristDir = _v0.set(0, 0, 0).copy(target).sub(elbowPos);
  if (wristDir.lengthSq() < 1e-8) wristDir.set(0, -1, 0);
  wristDir.normalize();

  // Transform wristDir into bone B local space by undoing bone A rotation
  _q1.copy(_q0).invert();
  wristDir.applyQuaternion(_q1);

  // Bone B rotation: from rest (0, -1, 0) to wristDir (in bone A local)
  _q1.setFromUnitVectors(restDir, wristDir);
  const rotB = new THREE.Euler().setFromQuaternion(_q1);

  return { rotA, rotB };
}
