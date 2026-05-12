/**
 * Render a SkeletonDef as visible bones — one cylinder per parent→child
 * pair, joint dots at each bone origin. Applies per-frame pose
 * rotations from an evaluator (same FK convention as the engine
 * renderer: restRot + restPos in bone-local frame, children inherit).
 *
 * Pure rendering: no UI, no game content. The Preact wrapper feeds
 * `applyPose()` from a clip evaluator each frame.
 *
 * Axis mapping mirrors engine entity_mesh: model (x, y, z) → three.js
 * (x, z, y), so the skeleton's restZ shows as three.js Y (up).
 */
import * as THREE from "three";

export interface BoneLike {
  id: string;
  parent: string | null;
  restX: number;
  restY: number;
  restZ: number;
  restRotX?: number;
  restRotY?: number;
  restRotZ?: number;
}

export interface SkeletonViewOptions {
  /** Uniform scale for bone positions. */
  scale: number;
  /** Optional override per-bone scale (matches engine boneScaleX/Y/Z). */
  boneScaleX?: Map<string, number>;
  boneScaleY?: Map<string, number>;
  boneScaleZ?: Map<string, number>;
  /** Bone whose tip is anchored as the camera focus. */
  rootJointColor?: number;
  jointColor?: number;
  boneColor?: number;
}

export interface SkeletonView {
  group: THREE.Group;
  boneGroups: Map<string, THREE.Group>;
  bbox: THREE.Box3;
  /** Set per-frame bone rotations (Euler XYZ, radians). */
  applyPose(pose: Map<string, { x: number; y: number; z: number }>): void;
  dispose(): void;
}

export function buildSkeletonView(
  bones: BoneLike[],
  opts: Partial<SkeletonViewOptions> = {},
): SkeletonView {
  const o: SkeletonViewOptions = {
    scale: 1,
    rootJointColor: 0xff8866,
    jointColor: 0xffcc66,
    boneColor: 0x88aaff,
    ...opts,
  };

  const group = new THREE.Group();
  group.name = "skeleton";
  const boneGroups = new Map<string, THREE.Group>();
  const disposers: Array<() => void> = [];

  // Build parent-first so each bone's group can be parented to its
  // existing parent group.
  const jointGeo = new THREE.SphereGeometry(0.06, 12, 10);
  const jointMat = new THREE.MeshLambertMaterial({ color: o.jointColor });
  const rootJointMat = new THREE.MeshLambertMaterial({ color: o.rootJointColor });
  disposers.push(() => { jointMat.dispose(); rootJointMat.dispose(); jointGeo.dispose(); });

  for (const bone of bones) {
    const sx = opts.boneScaleX?.get(bone.id) ?? 1;
    const sy = opts.boneScaleY?.get(bone.id) ?? 1;
    const sz = opts.boneScaleZ?.get(bone.id) ?? 1;
    const rx = bone.restX * sx;
    const ry = bone.restY * sy;
    const rz = bone.restZ * sz;

    const bg = new THREE.Group();
    bg.name = `bone:${bone.id}`;
    bg.position.set(rx * o.scale, rz * o.scale, ry * o.scale);
    bg.rotation.set(bone.restRotX ?? 0, bone.restRotY ?? 0, bone.restRotZ ?? 0);

    const parent = bone.parent !== null ? boneGroups.get(bone.parent) : null;
    (parent ?? group).add(bg);

    // Joint marker at the bone's origin (in its own local frame).
    const joint = new THREE.Mesh(jointGeo, bone.parent === null ? rootJointMat : jointMat);
    bg.add(joint);

    boneGroups.set(bone.id, bg);
  }

  // Connecting cylinders: parent→child. Cylinder lives in the PARENT'S
  // local frame, oriented from parent origin (0,0,0) to the child's
  // local position. We anchor the cylinder geometry at one end by
  // applying a half-length translate so it visually starts at the
  // parent joint and ends at the child joint.
  const boneMat = new THREE.MeshLambertMaterial({ color: o.boneColor });
  disposers.push(() => boneMat.dispose());

  for (const bone of bones) {
    if (bone.parent === null) continue;
    const parentGroup = boneGroups.get(bone.parent);
    if (!parentGroup) continue;
    const childGroup  = boneGroups.get(bone.id);
    if (!childGroup) continue;

    const childPos = childGroup.position;
    const len = childPos.length();
    if (len < 1e-4) continue;

    const cylGeo = new THREE.CylinderGeometry(0.025, 0.025, len, 8, 1, true);
    // CylinderGeometry is centered along Y; translate by len/2 so its
    // BASE sits at the parent's origin, TIP at the child's offset.
    cylGeo.translate(0, len / 2, 0);
    const cyl = new THREE.Mesh(cylGeo, boneMat);

    // Orient the cylinder so its +Y axis points from parent origin to
    // child's local position. setFromUnitVectors(default +Y, dir) does it.
    const dir = childPos.clone().normalize();
    cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

    parentGroup.add(cyl);
    disposers.push(() => cylGeo.dispose());
  }

  // Compute initial AABB by traversing all joint world positions.
  const bbox = new THREE.Box3();
  group.updateMatrixWorld(true);
  for (const bg of boneGroups.values()) {
    const wp = new THREE.Vector3();
    bg.getWorldPosition(wp);
    bbox.expandByPoint(wp);
  }
  if (bbox.isEmpty()) bbox.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));

  const restRot = new Map<string, [number, number, number]>();
  for (const b of bones) restRot.set(b.id, [b.restRotX ?? 0, b.restRotY ?? 0, b.restRotZ ?? 0]);

  return {
    group,
    boneGroups,
    bbox,
    applyPose(pose) {
      for (const [id, bg] of boneGroups) {
        const r = pose.get(id);
        if (r) {
          bg.rotation.set(r.x, r.y, r.z);
        } else {
          // No pose entry → rest rotation. Mirrors engine fallback.
          const rest = restRot.get(id)!;
          bg.rotation.set(rest[0], rest[1], rest[2]);
        }
      }
    },
    dispose() {
      for (const d of disposers) d();
      group.removeFromParent();
    },
  };
}
