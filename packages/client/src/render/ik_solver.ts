/**
 * Two-bone IK solver — THREE.js wrapper around the shared pure-math solver in
 * @voxim/content. Signature is identical to the previous implementation so
 * skeleton_evaluator.ts requires no changes.
 */
import * as THREE from "three";
import { solveTwoBoneIK as _solve } from "@voxim/content";

export function solveTwoBoneIK(
  boneALen: number,
  boneBLen: number,
  target: THREE.Vector3,
  poleHint: THREE.Vector3,
): { rotA: THREE.Euler; rotB: THREE.Euler } {
  const result = _solve(
    boneALen,
    boneBLen,
    { x: target.x, y: target.y, z: target.z },
    { x: poleHint.x, y: poleHint.y, z: poleHint.z },
  );
  return {
    rotA: new THREE.Euler(result.rotA.x, result.rotA.y, result.rotA.z),
    rotB: new THREE.Euler(result.rotB.x, result.rotB.y, result.rotB.z),
  };
}
