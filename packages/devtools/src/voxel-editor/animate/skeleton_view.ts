/**
 * Skeleton viewport visualization for the animation editor.
 *
 * Builds a Three.js group with:
 *   - Line segments connecting bones (parent → child)
 *   - Small spheres at each bone origin (for picking)
 *
 * Coordinate mapping (model space → Three.js):
 *   model x (right)    → three x
 *   model y (forward)  → three z
 *   model z (up)       → three y
 *
 * This is the same mapping used by entity_mesh.ts / upgradeToSkeletonModel().
 */
import * as THREE from "three";
import { scene } from "../viewport.ts";
import type { SkeletonDef } from "@voxim/content";

// ---- shared geometry/material ----

const GEO_SPHERE = new THREE.SphereGeometry(0.12, 8, 6);
const GEO_CUBE   = new THREE.BoxGeometry(0.08, 0.08, 0.08);

function makeBoneMat(selected: boolean): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({
    color: selected ? 0xffcc44 : 0x6699ff,
    emissive: selected ? 0x332200 : 0x000022,
    flatShading: true,
    shininess: 0,
  });
}

// ---- module state ----

let _group: THREE.Group | null = null;
let _boneGroups = new Map<string, THREE.Group>();
let _boneSpheres: THREE.Mesh[] = [];
let _selectedBoneId: string | null = null;

// ---- public API ----

/** Build the skeleton visualization and add it to the scene. Clears any existing view. */
export function buildSkeletonView(skeleton: SkeletonDef): void {
  clearSkeletonView();

  const group = new THREE.Group();
  const boneGroups = new Map<string, THREE.Group>();
  const boneSpheres: THREE.Mesh[] = [];

  for (const bone of skeleton.bones) {
    const bg = new THREE.Group();
    bg.name = `bone:${bone.id}`;
    // model → three coordinate mapping
    bg.position.set(bone.restX, bone.restZ, bone.restY);

    const parentGroup = bone.parent !== null
      ? (boneGroups.get(bone.parent) ?? group)
      : group;
    parentGroup.add(bg);
    boneGroups.set(bone.id, bg);

    // Sphere at bone origin (for picking + visual)
    const sphere = new THREE.Mesh(GEO_SPHERE, makeBoneMat(false));
    sphere.userData.boneId = bone.id;
    sphere.name = `sphere:${bone.id}`;
    bg.add(sphere);
    boneSpheres.push(sphere);

    // Line from parent origin to this bone's local position
    if (bone.parent) {
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(bone.restX, bone.restZ, bone.restY),
      ]);
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x334466 }));
      parentGroup.add(line);
    }
  }

  _group = group;
  _boneGroups = boneGroups;
  _boneSpheres = boneSpheres;
  _selectedBoneId = null;
  scene.add(group);
}

/** Remove the skeleton visualization from the scene and dispose resources. */
export function clearSkeletonView(): void {
  if (!_group) return;
  scene.remove(_group);
  _group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    } else if (obj instanceof THREE.Line) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
  });
  _group = null;
  _boneGroups = new Map();
  _boneSpheres = [];
  _selectedBoneId = null;
}

/**
 * Apply FK bone rotations to the visualization groups.
 * Call after evaluateAnimationLayers() → convert to THREE.Euler.
 */
export function applyPoseToView(pose: Map<string, THREE.Euler>): void {
  for (const [boneId, rot] of pose) {
    const bg = _boneGroups.get(boneId);
    if (bg) bg.rotation.copy(rot);
  }
}

/** Reset all bone group rotations to rest pose (zero). */
export function resetToRestPose(): void {
  for (const [, bg] of _boneGroups) {
    bg.rotation.set(0, 0, 0);
  }
}

/** Highlight the selected bone sphere; clear highlight on all others. */
export function highlightBone(boneId: string | null): void {
  if (boneId === _selectedBoneId) return;
  _selectedBoneId = boneId;
  for (const sphere of _boneSpheres) {
    const isSelected = sphere.userData.boneId === boneId;
    (sphere.material as THREE.MeshPhongMaterial).color.set(isSelected ? 0xffcc44 : 0x6699ff);
    (sphere.material as THREE.MeshPhongMaterial).emissive.set(isSelected ? 0x332200 : 0x000022);
  }
}

/** Return all bone sphere meshes (for raycasting in bone_pick.ts). */
export function getBoneSpheres(): THREE.Mesh[] { return _boneSpheres; }

/** Return the bone group map (for external IK or world-position reads). */
export function getBoneGroups(): ReadonlyMap<string, THREE.Group> { return _boneGroups; }
