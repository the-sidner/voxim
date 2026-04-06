/**
 * SkeletonOverlay — debug visualisation of bone hierarchies.
 *
 * When enabled, renders on top of all geometry (depthTest: false):
 *   - Yellow LineSegments connecting each parent bone to its children
 *   - Orange Points marking each joint pivot
 *
 * Usage:
 *   overlay.trackEntity(entityId, mesh, skeleton)  — call after upgradeToSkeletonModel
 *   overlay.untrackEntity(entityId)                — call before removeEntity
 *   overlay.update(entityMeshes)                   — call each frame, after pose update
 *   overlay.toggle()                               — returns new enabled state
 */
import * as THREE from "three";
import type { SkeletonDef } from "@voxim/content";
import type { EntityMeshGroup } from "./entity_mesh.ts";

// depthTest: false + opaque pass (no transparent:true) + renderOrder:999
// guarantees the overlay always draws on top of all entity geometry.
const MAT_LINES = new THREE.LineBasicMaterial({
  color: 0xffff00,
  depthTest: false,
  depthWrite: false,
});

const MAT_JOINTS = new THREE.PointsMaterial({
  color: 0xff5500,
  size: 0.1,
  depthTest: false,
  depthWrite: false,
  sizeAttenuation: true,
});

interface EntityEntry {
  skeleton: SkeletonDef;
  lineSegs: THREE.LineSegments;
  joints: THREE.Points;
}

export class SkeletonOverlay {
  private readonly scene: THREE.Scene;
  private readonly entries = new Map<string, EntityEntry>();
  private readonly tmp = new THREE.Vector3();
  enabled = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Toggle visibility; returns the new enabled state. */
  toggle(): boolean {
    this.enabled = !this.enabled;
    for (const [, e] of this.entries) {
      e.lineSegs.visible = this.enabled;
      e.joints.visible   = this.enabled;
    }
    return this.enabled;
  }

  /**
   * Register an entity's skeleton for overlay rendering.
   * Call immediately after upgradeToSkeletonModel.
   */
  trackEntity(entityId: string, mesh: EntityMeshGroup, skeleton: SkeletonDef): void {
    this.untrackEntity(entityId); // replace if already tracked

    const nonRootBones = skeleton.bones.filter((b) => b.parent !== null);

    // LineSegments: 2 positions per non-root bone (parent → child)
    const lineBuf = new Float32Array(nonRootBones.length * 6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(lineBuf, 3));
    const lineSegs = new THREE.LineSegments(lineGeo, MAT_LINES);
    lineSegs.renderOrder = 999;
    lineSegs.visible = this.enabled;
    lineSegs.frustumCulled = false;

    // Points: 1 position per bone
    const pointBuf = new Float32Array(skeleton.bones.length * 3);
    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute("position", new THREE.BufferAttribute(pointBuf, 3));
    const joints = new THREE.Points(pointGeo, MAT_JOINTS);
    joints.renderOrder = 999;
    joints.visible = this.enabled;
    joints.frustumCulled = false;

    this.scene.add(lineSegs, joints);
    this.entries.set(entityId, { skeleton, lineSegs, joints });

    // Run an initial sync so positions aren't at origin on first visible frame
    if (mesh.boneGroups) {
      mesh.group.updateWorldMatrix(false, true);
      this.syncEntry(this.entries.get(entityId)!, mesh.boneGroups);
    }
  }

  /** Deregister an entity and remove its overlay objects from the scene. */
  untrackEntity(entityId: string): void {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    this.scene.remove(entry.lineSegs, entry.joints);
    entry.lineSegs.geometry.dispose();
    entry.joints.geometry.dispose();
    this.entries.delete(entityId);
  }

  /**
   * Sync overlay geometry to current bone world positions.
   * Must be called AFTER pose rotations have been applied to bone groups,
   * and BEFORE the Three.js render call.
   */
  update(entityMeshes: Map<string, EntityMeshGroup>): void {
    if (!this.enabled) return;
    for (const [entityId, entry] of this.entries) {
      const mesh = entityMeshes.get(entityId);
      if (!mesh?.boneGroups) continue;
      // Propagate rotation changes into world matrices before reading positions
      mesh.group.updateWorldMatrix(false, true);
      this.syncEntry(entry, mesh.boneGroups);
    }
  }

  private syncEntry(entry: EntityEntry, boneGroups: Map<string, THREE.Group>): void {
    const { skeleton, lineSegs, joints } = entry;
    const linePosAttr  = lineSegs.geometry.attributes.position as THREE.BufferAttribute;
    const jointPosAttr = joints.geometry.attributes.position  as THREE.BufferAttribute;

    // Joint positions
    let ji = 0;
    for (const bone of skeleton.bones) {
      const bg = boneGroups.get(bone.id);
      if (bg) {
        bg.getWorldPosition(this.tmp);
        jointPosAttr.setXYZ(ji, this.tmp.x, this.tmp.y, this.tmp.z);
      }
      ji++;
    }
    jointPosAttr.needsUpdate = true;

    // Line segment positions: one segment per non-root bone (parent → child)
    let li = 0;
    for (const bone of skeleton.bones) {
      if (bone.parent === null) continue;
      const parentBg = boneGroups.get(bone.parent);
      const childBg  = boneGroups.get(bone.id);
      if (parentBg && childBg) {
        parentBg.getWorldPosition(this.tmp);
        linePosAttr.setXYZ(li, this.tmp.x, this.tmp.y, this.tmp.z);
        li++;
        childBg.getWorldPosition(this.tmp);
        linePosAttr.setXYZ(li, this.tmp.x, this.tmp.y, this.tmp.z);
        li++;
      } else {
        // Missing bone — write degenerate segment (same point) to keep index stable
        linePosAttr.setXYZ(li,     0, 0, 0);
        linePosAttr.setXYZ(li + 1, 0, 0, 0);
        li += 2;
      }
    }
    linePosAttr.needsUpdate = true;
  }

  dispose(): void {
    for (const [id] of this.entries) this.untrackEntity(id);
    // Shared materials are not disposed here — they're module-level singletons
  }
}
