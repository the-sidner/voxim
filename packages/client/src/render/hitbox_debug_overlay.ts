/**
 * HitboxDebugOverlay — visualises the server-side Hitbox capsules, computed
 * locally on the client each frame using the same pipeline as HitboxSystem:
 *
 *   evaluateAnimationLayers → solveSkeleton → applyHitboxTemplate
 *
 * Each BodyPartVolume is rendered as:
 *   - A line segment from → to
 *   - A cylinder hull between the endpoints (shows the actual radius)
 *   - Small spheres at each endpoint cap
 *
 * The container is parented to the entity's mesh group so it moves with the
 * entity automatically.  Entity-local positions of the parts are updated each
 * frame as the skeleton animates.
 *
 * Implements ManagedOverlay — registered in DebugOverlayManager as "hitbox".
 */
import * as THREE from "three";
import type { ManagedOverlay, DebugUpdateContext } from "./debug_overlay_manager.ts";
import type { EntityMeshGroup } from "./entity_mesh.ts";
import type { BodyPartVolume } from "@voxim/content";
import {
  evaluateAnimationLayers,
  solveSkeleton,
  applyHitboxTemplate,
  resolveMorphParams,
  REST_POSE,
} from "@voxim/content";

/**
 * Three.js layer used exclusively by the hitbox debug overlay.
 * Objects on this layer are excluded from the main pixel-art pass (Pass 1)
 * and rendered in a dedicated overlay pass (Pass 4) directly to the canvas.
 */
export const HITBOX_OVERLAY_LAYER = 31;

// ── Shared geometry (never disposed per-entry) ────────────────────────────────

const SPHERE_GEO   = new THREE.SphereGeometry(1, 6, 4);
const CYLINDER_GEO = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);

const MAT_LINE = new THREE.LineBasicMaterial({
  color: 0x00ffcc, depthTest: false, depthWrite: false,
});
const MAT_WIRE = new THREE.MeshBasicMaterial({
  color: 0x00ffcc, wireframe: true,
  depthTest: false, depthWrite: false, transparent: true, opacity: 0.35,
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface PartGeo {
  line:       THREE.Line;
  cylinder:   THREE.Mesh;
  fromSphere: THREE.Mesh;
  toSphere:   THREE.Mesh;
}

interface HitboxEntry {
  container: THREE.Object3D;
  parts: PartGeo[];
}

// ── Coordinate conversion ─────────────────────────────────────────────────────

/** Entity-local (right, fwd, up) → Three.js local (right, up, −fwd). */
function toThree(right: number, fwd: number, up: number): THREE.Vector3 {
  return new THREE.Vector3(right, up, -fwd);
}

// ── Part geometry helpers ─────────────────────────────────────────────────────

function buildParts(parts: BodyPartVolume[]): { container: THREE.Object3D; partGeos: PartGeo[] } {
  const container = new THREE.Object3D();
  const partGeos: PartGeo[] = [];

  for (const part of parts) {
    const from = toThree(part.fromRight, part.fromFwd, part.fromUp);
    const to   = toThree(part.toRight,   part.toFwd,   part.toUp);
    const r    = part.radius;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([
      from.x, from.y, from.z, to.x, to.y, to.z,
    ], 3));
    const line = new THREE.Line(geo, MAT_LINE.clone());
    line.renderOrder = 998;

    const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    const len = from.distanceTo(to);
    const cylinder = new THREE.Mesh(CYLINDER_GEO, MAT_WIRE.clone());
    cylinder.renderOrder = 998;
    cylinder.position.copy(mid);
    cylinder.scale.set(r, len > 0 ? len : 0.001, r);
    if (len > 0.0001) {
      const axis = new THREE.Vector3().subVectors(to, from).normalize();
      cylinder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    }

    const fromSphere = new THREE.Mesh(SPHERE_GEO, MAT_WIRE.clone());
    fromSphere.position.copy(from);
    fromSphere.scale.setScalar(r);
    fromSphere.renderOrder = 998;

    const toSphere = new THREE.Mesh(SPHERE_GEO, MAT_WIRE.clone());
    toSphere.position.copy(to);
    toSphere.scale.setScalar(r);
    toSphere.renderOrder = 998;

    container.add(line, cylinder, fromSphere, toSphere);
    partGeos.push({ line, cylinder, fromSphere, toSphere });
  }

  container.traverse((obj) => obj.layers.set(HITBOX_OVERLAY_LAYER));
  return { container, partGeos };
}

/** Update existing part geometry in place — avoids rebuilding Three.js objects each frame. */
function updateParts(partGeos: PartGeo[], parts: BodyPartVolume[]): void {
  for (let i = 0; i < partGeos.length && i < parts.length; i++) {
    const pg   = partGeos[i];
    const part = parts[i];

    const from = toThree(part.fromRight, part.fromFwd, part.fromUp);
    const to   = toThree(part.toRight,   part.toFwd,   part.toUp);
    const r    = part.radius;

    const posAttr = pg.line.geometry.getAttribute("position") as THREE.BufferAttribute;
    posAttr.setXYZ(0, from.x, from.y, from.z);
    posAttr.setXYZ(1, to.x,   to.y,   to.z);
    posAttr.needsUpdate = true;

    const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    const len = from.distanceTo(to);
    pg.cylinder.position.copy(mid);
    pg.cylinder.scale.set(r, len > 0 ? len : 0.001, r);
    if (len > 0.0001) {
      const axis = new THREE.Vector3().subVectors(to, from).normalize();
      pg.cylinder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    }

    pg.fromSphere.position.copy(from);
    pg.fromSphere.scale.setScalar(r);
    pg.toSphere.position.copy(to);
    pg.toSphere.scale.setScalar(r);
  }
}

function disposePartGeos(partGeos: PartGeo[]): void {
  for (const pg of partGeos) {
    pg.line.geometry.dispose();
    (pg.line.material       as THREE.Material).dispose();
    (pg.cylinder.material   as THREE.Material).dispose();
    (pg.fromSphere.material as THREE.Material).dispose();
    (pg.toSphere.material   as THREE.Material).dispose();
  }
}

// ── Overlay class ─────────────────────────────────────────────────────────────

export class HitboxDebugOverlay implements ManagedOverlay {
  private readonly entries = new Map<string, HitboxEntry>();

  onToggle(on: boolean): void {
    for (const entry of this.entries.values()) {
      entry.container.visible = on;
    }
  }

  /**
   * Compute hitboxes locally each frame from the entity's animation state.
   * Uses the same evaluateAnimationLayers → solveSkeleton → applyHitboxTemplate
   * pipeline as the server's HitboxSystem.
   */
  update(ctx: DebugUpdateContext): void {
    if (!ctx.content) return;

    const seen = new Set<string>();

    for (const [entityId, mesh] of ctx.entityMeshes) {
      const { modelId, skeletonId, animationState, modelSeed, modelScale } = mesh;
      if (!modelId || !skeletonId || modelScale === 0) continue;

      const skeleton = ctx.content.getSkeletonSync(skeletonId);
      if (!skeleton) continue;

      const boneIndex   = ctx.content.getBoneIndex(skeletonId);
      const clipIndex   = ctx.content.getClipIndex(skeletonId);
      const maskIndex   = ctx.content.getMaskIndex(skeletonId);
      const template    = ctx.content.getHitboxTemplate(modelId, modelSeed, modelScale);
      if (template.length === 0) continue;

      const poseRotations = animationState?.layers.length
        ? evaluateAnimationLayers(skeleton, clipIndex, maskIndex, animationState.layers)
        : REST_POSE;

      const morphParams   = resolveMorphParams(skeleton, modelSeed);
      const boneTransforms = solveSkeleton(skeleton, boneIndex, poseRotations, modelScale, morphParams);
      const parts          = applyHitboxTemplate(template, boneTransforms);
      if (parts.length === 0) continue;

      this.syncEntry(entityId, mesh, parts);
      seen.add(entityId);
    }

    for (const [entityId, entry] of this.entries) {
      entry.container.visible = seen.has(entityId);
    }
  }

  removeEntity(entityId: string): void {
    this.removeEntry(entityId);
  }

  dispose(): void {
    for (const entityId of [...this.entries.keys()]) this.removeEntry(entityId);
  }

  // ── private ──────────────────────────────────────────────────────────────

  private syncEntry(entityId: string, mesh: EntityMeshGroup, parts: BodyPartVolume[]): void {
    const existing = this.entries.get(entityId);

    if (existing && existing.parts.length === parts.length) {
      // Update positions in place — avoids geometry rebuild every frame.
      updateParts(existing.parts, parts);
      existing.container.visible = true;
      return;
    }

    // Part count changed (or first time) — rebuild container.
    if (existing) {
      existing.container.parent?.remove(existing.container);
      disposePartGeos(existing.parts);
    }

    const { container, partGeos } = buildParts(parts);
    container.visible = true;
    mesh.group.add(container);
    this.entries.set(entityId, { container, parts: partGeos });
  }

  private removeEntry(entityId: string): void {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    entry.container.parent?.remove(entry.container);
    disposePartGeos(entry.parts);
    this.entries.delete(entityId);
  }
}
