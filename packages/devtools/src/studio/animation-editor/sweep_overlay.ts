/**
 * Swing-sweep overlay (T-322) — renders a swingPath-bearing WeaponActionDef's
 * blade arc + swept capsule against the studio's skeleton view.
 *
 * Reuses the REAL producer chain — no re-implementation:
 *   - `sampleSwingPath` (the same function the server's weapon_trace resolver
 *     calls to build the swept hit segments)
 *   - `solveSwingPose` (the same procedural full-body IK producer the client
 *     renderer runs) to pose the arm onto the hilt
 *
 * The posed rotations feed straight into the existing SkeletonView.applyPose
 * (same Euler-per-bone convention as clip playback — see skeleton_view.ts /
 * clip_sampler.ts), so this panel shares the one skeleton rig the Clip and
 * Morph tabs already draw. The blade box + arc trail are extra Three.js
 * objects parented into the viewport's content group, not the bone
 * hierarchy — their vertices are computed fresh each frame from the hand
 * bone's WORLD transform (read back off the posed SkeletonView), matching
 * how the client's standalone Swing Inspector places its blade.
 */
import * as THREE from "three";
import {
  solveSwingPose, sampleSwingPath,
  type SkeletonDef, type BoneDef, type BoneRotation, type SwingPathDef,
} from "@voxim/content";
import type { SkeletonView } from "./skeleton_view.ts";

/** Build the full-body swing pose rotations for one instant and push them
 *  into the skeleton view (same call the client renderer/inspector make). */
export function poseSwingAt(
  skeleton: SkeletonDef,
  boneIndex: ReadonlyMap<string, BoneDef>,
  view: SkeletonView,
  swingPath: SwingPathDef,
  t: number,
): void {
  const rot: Map<string, BoneRotation> = solveSwingPose(skeleton, boneIndex, new Map(), 1, swingPath, t, {});
  view.applyPose(rot);
}

export interface SweepBlade {
  base: THREE.Vector3;
  tip: THREE.Vector3;
  radius: number;
}

/**
 * Read the swung blade's world-space base/tip off the ALREADY-POSED skeleton
 * view (call poseSwingAt first). base = hand bone world position; tip = base
 * + the hand's world-rotated +Y (bladeAxisLocal default) * swingPath.length.
 * This is the exact geometry solveSwingPose's aimLimb aimed the hand onto —
 * hit == visual by construction (same invariant the game relies on).
 */
export function readSwungBlade(
  view: SkeletonView,
  swingPath: SwingPathDef,
  handBone = "hand_r",
): SweepBlade | null {
  const base = readHandWorld(view, handBone);
  if (!base) return null;
  const bone = view.boneGroups.get(handBone)!;
  const worldQuat = new THREE.Quaternion();
  bone.getWorldQuaternion(worldQuat);
  const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(worldQuat);
  const tip = base.clone().addScaledVector(axis, swingPath.length);
  return { base, tip, radius: swingPath.radius };
}

/** World-space position of a bone in the (already-posed) skeleton view. */
export function readHandWorld(view: SkeletonView, handBone: string): THREE.Vector3 | null {
  const bone = view.boneGroups.get(handBone);
  if (!bone) return null;
  bone.updateMatrixWorld(true);
  const pos = new THREE.Vector3();
  bone.getWorldPosition(pos);
  return pos;
}

/**
 * Authored hilt target at `t`, in the same actor-local-origin solver space
 * `sampleSwingPath` uses (the panel previews the swing in place, with no
 * world facing applied — same convention the client Swing Inspector uses).
 * Lets the caller compare "where the arm's IK actually put the hand" vs.
 * "where the authored arc asked it to be" (an over-reach tell).
 */
export function sampleHiltWorld(swingPath: SwingPathDef, t: number): THREE.Vector3 {
  const s = sampleSwingPath(swingPath, t);
  return new THREE.Vector3(s.hilt.x, s.hilt.y, s.hilt.z);
}

/** Manages the persistent Three.js objects for the sweep overlay: the
 *  current blade capsule, the hilt target marker + guide line (authored
 *  hilt vs. where the IK'd hand actually landed — the same over-reach tell
 *  the client inspector surfaces), and the full-arc tip trail. */
export class SweepOverlay {
  readonly group = new THREE.Group();
  private blade: THREE.Mesh;
  private bladeGeo = new THREE.BoxGeometry(1, 1, 1);
  private bladeMatActive = new THREE.MeshBasicMaterial({ color: 0xee5533 });
  private bladeMatIdle = new THREE.MeshBasicMaterial({ color: 0xd97826 });
  private hiltDot: THREE.Mesh;
  private guide: THREE.Line;
  private guideGeo = new THREE.BufferGeometry();
  private arcLine: THREE.Line;
  private arcGeo = new THREE.BufferGeometry();
  private static readonly ARC_SAMPLES = 64;
  private sweepTrail: THREE.Mesh[] = [];

  constructor() {
    this.group.name = "sweep-overlay";

    this.blade = new THREE.Mesh(this.bladeGeo, this.bladeMatIdle);
    this.group.add(this.blade);

    this.hiltDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x39d7c0 }),
    );
    this.hiltDot.visible = false;
    this.group.add(this.hiltDot);

    this.guideGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    this.guide = new THREE.Line(this.guideGeo, new THREE.LineDashedMaterial({ color: 0x39d7c0, dashSize: 0.08, gapSize: 0.05 }));
    this.guide.visible = false;
    this.group.add(this.guide);

    const arcPts = new Float32Array(SweepOverlay.ARC_SAMPLES * 3);
    this.arcGeo.setAttribute("position", new THREE.BufferAttribute(arcPts, 3));
    this.arcLine = new THREE.Line(this.arcGeo, new THREE.LineBasicMaterial({ color: 0x5a7fb0 }));
    this.group.add(this.arcLine);
  }

  /** Place the blade box spanning base→tip, tinted red when the active
   *  window is live (matches the client inspector's active-tick flash). */
  setBlade(base: THREE.Vector3, tip: THREE.Vector3, radius: number, active: boolean): void {
    this.blade.material = active ? this.bladeMatActive : this.bladeMatIdle;
    const mid = base.clone().add(tip).multiplyScalar(0.5);
    this.blade.position.copy(mid);
    const dir = tip.clone().sub(base);
    const len = Math.max(0.01, dir.length());
    this.blade.scale.set(Math.max(0.02, radius * 2), Math.max(0.02, radius * 2), len);
    this.blade.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize());
  }

  /** Authored hilt target (world) + the arm's actual hand position, so an
   *  over-reach gap (arm too short for the authored arc) is visible. */
  setHiltGuide(handWorldPos: THREE.Vector3, hiltWorldPos: THREE.Vector3): void {
    const gap = handWorldPos.distanceTo(hiltWorldPos);
    const show = gap > 0.03;
    this.hiltDot.visible = show;
    this.guide.visible = show;
    if (!show) return;
    this.hiltDot.position.copy(hiltWorldPos);
    const pos = this.guideGeo.getAttribute("position") as THREE.BufferAttribute;
    pos.setXYZ(0, handWorldPos.x, handWorldPos.y, handWorldPos.z);
    pos.setXYZ(1, hiltWorldPos.x, hiltWorldPos.y, hiltWorldPos.z);
    pos.needsUpdate = true;
    this.guide.computeLineDistances();
  }

  /**
   * Rebuild the tip-arc trail (the whole swing's shape at a glance) by
   * sampling `sampleSwingPath` directly — the same function weapon_trace
   * reads. Actor-local solver space is placed at the character's local
   * origin (no world facing applied — the panel views the swing in place,
   * matching the client inspector's convention).
   */
  buildArc(swingPath: SwingPathDef): void {
    const pos = this.arcGeo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < SweepOverlay.ARC_SAMPLES; i++) {
      const t = i / (SweepOverlay.ARC_SAMPLES - 1);
      const s = sampleSwingPath(swingPath, t);
      const tipX = s.hilt.x + s.bladeDir.x * s.length;
      const tipY = s.hilt.y + s.bladeDir.y * s.length;
      const tipZ = s.hilt.z + s.bladeDir.z * s.length;
      pos.setXYZ(i, tipX, tipY, tipZ);
    }
    pos.needsUpdate = true;
  }

  /**
   * Swept-volume overlay across the action's active window: bake N
   * translucent blade capsules at evenly spaced t within [activeStart,
   * activeEnd] so the volume the weapon actually threatens over the active
   * ticks is visible all at once, not just at the scrubbed instant.
   */
  buildSweptVolume(
    skeleton: SkeletonDef,
    boneIndex: ReadonlyMap<string, BoneDef>,
    view: SkeletonView,
    swingPath: SwingPathDef,
    handBone: string,
    activeStart: number,
    activeEnd: number,
    samples: number,
  ): void {
    this.clearSweptVolume();
    const n = Math.max(2, samples);
    for (let i = 0; i < n; i++) {
      const t = activeStart + (activeEnd - activeStart) * (i / (n - 1));
      poseSwingAt(skeleton, boneIndex, view, swingPath, t);
      const blade = readSwungBlade(view, swingPath, handBone);
      if (!blade) continue;
      const dir = blade.tip.clone().sub(blade.base);
      const len = Math.max(0.01, dir.length());
      const geo = new THREE.CylinderGeometry(Math.max(0.02, blade.radius), Math.max(0.02, blade.radius), len, 8, 1, true);
      // Cylinder's default long axis is +Y; rotate it onto +Z so the
      // setFromUnitVectors(+Z, dir) below (same convention as the blade
      // box) orients it base->tip.
      geo.rotateX(Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: 0xee5533, transparent: true, opacity: 0.10, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      const mid = blade.base.clone().add(blade.tip).multiplyScalar(0.5);
      mesh.position.copy(mid);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize());
      this.group.add(mesh);
      this.sweepTrail.push(mesh);
    }
  }

  clearSweptVolume(): void {
    for (const m of this.sweepTrail) {
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.sweepTrail = [];
  }

  dispose(): void {
    this.clearSweptVolume();
    this.group.removeFromParent();
    this.bladeGeo.dispose();
    this.bladeMatActive.dispose();
    this.bladeMatIdle.dispose();
    (this.hiltDot.geometry as THREE.BufferGeometry).dispose();
    (this.hiltDot.material as THREE.Material).dispose();
    this.guideGeo.dispose();
    (this.guide.material as THREE.Material).dispose();
    this.arcGeo.dispose();
    (this.arcLine.material as THREE.Material).dispose();
  }
}
