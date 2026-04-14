/**
 * SkeletonOverlay — debug visualisation of bone hierarchies.
 *
 * When enabled, renders on top of all geometry (depthTest: false):
 *   - Yellow LineSegments connecting each parent bone to its children
 *   - Orange Points marking each joint pivot
 *
 * Usage (event-driven, called directly via manager.get):
 *   overlay.trackEntity(entityId, mesh, skeleton)  — after upgradeToSkeletonModel
 *   overlay.untrackEntity(entityId)                — before removeEntity
 *
 * Implements ManagedOverlay — registered in DebugOverlayManager as "skeleton".
 */
import * as THREE from "three";
import type { SkeletonDef } from "@voxim/content";
import type { EntityMeshGroup } from "./entity_mesh.ts";
import type { ManagedOverlay, DebugUpdateContext } from "./debug_overlay_manager.ts";

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

export class SkeletonOverlay implements ManagedOverlay {
  private readonly scene: THREE.Scene;
  private readonly entries = new Map<string, EntityEntry>();
  private readonly tmp = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  onToggle(on: boolean): void {
    for (const e of this.entries.values()) {
      e.lineSegs.visible = on;
      e.joints.visible   = on;
    }
  }

  /**
   * Register an entity's skeleton for overlay rendering.
   * Call immediately after upgradeToSkeletonModel.
   */
  trackEntity(entityId: string, mesh: EntityMeshGroup, skeleton: SkeletonDef): void {
    this.untrackEntity(entityId);

    const nonRootBones = skeleton.bones.filter((b) => b.parent !== null);

    const lineBuf = new Float32Array(nonRootBones.length * 6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(lineBuf, 3));
    const lineSegs = new THREE.LineSegments(lineGeo, MAT_LINES);
    lineSegs.renderOrder = 999;
    lineSegs.frustumCulled = false;

    const pointBuf = new Float32Array(skeleton.bones.length * 3);
    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute("position", new THREE.BufferAttribute(pointBuf, 3));
    const joints = new THREE.Points(pointGeo, MAT_JOINTS);
    joints.renderOrder = 999;
    joints.frustumCulled = false;

    // Start hidden — onToggle(true) will show them when the overlay is enabled.
    lineSegs.visible = false;
    joints.visible   = false;

    this.scene.add(lineSegs, joints);
    this.entries.set(entityId, { skeleton, lineSegs, joints });

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

  update(ctx: DebugUpdateContext): void {
    for (const [entityId, entry] of this.entries) {
      const mesh = ctx.entityMeshes.get(entityId);
      if (!mesh?.boneGroups) continue;
      mesh.group.updateWorldMatrix(false, true);
      this.syncEntry(entry, mesh.boneGroups);
      entry.lineSegs.visible = true;
      entry.joints.visible   = true;
    }
  }

  removeEntity(entityId: string): void {
    this.untrackEntity(entityId);
  }

  private syncEntry(entry: EntityEntry, boneGroups: Map<string, THREE.Group>): void {
    const { skeleton, lineSegs, joints } = entry;
    const linePosAttr  = lineSegs.geometry.attributes.position as THREE.BufferAttribute;
    const jointPosAttr = joints.geometry.attributes.position  as THREE.BufferAttribute;

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
        linePosAttr.setXYZ(li,     0, 0, 0);
        linePosAttr.setXYZ(li + 1, 0, 0, 0);
        li += 2;
      }
    }
    linePosAttr.needsUpdate = true;
  }

  dispose(): void {
    for (const [id] of this.entries) this.untrackEntity(id);
  }
}
