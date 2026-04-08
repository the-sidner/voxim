/**
 * HitboxDebugOverlay — visualises the server-side Hitbox capsules.
 *
 * Each BodyPartVolume is rendered as:
 *   - A line segment from → to
 *   - A cylinder hull between the endpoints (shows the actual radius)
 *   - Small spheres at each endpoint cap
 *
 * For animated entities (players, NPCs) the container is parented to the
 * entity's mesh group so it moves with the entity automatically.
 * For static props the container is placed at world position directly in
 * the scene.
 *
 * Toggle with the "hitbox" debug layer (DebugPanel → Hitbox button).
 */
import * as THREE from "three";
import type { EntityMeshGroup } from "./entity_mesh.ts";
import type { HitboxData } from "@voxim/codecs";

/**
 * Three.js layer used exclusively by the hitbox debug overlay.
 * Objects on this layer are excluded from the main pixel-art pass (Pass 1)
 * and rendered in a dedicated overlay pass (Pass 3) directly to the canvas.
 */
export const HITBOX_OVERLAY_LAYER = 31;

// Shared geometry — not disposed per-entry.
const SPHERE_GEO = new THREE.SphereGeometry(1, 6, 4);
const CYLINDER_GEO = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true); // open-ended, unit size

const COLOR = 0x00ffcc;

const MAT_LINE = new THREE.LineBasicMaterial({
  color: COLOR, depthTest: false, depthWrite: false,
});
const MAT_WIRE = new THREE.MeshBasicMaterial({
  color: COLOR, wireframe: true,
  depthTest: false, depthWrite: false, transparent: true, opacity: 0.35,
});

interface PartGeo {
  line:       THREE.Line;
  cylinder:   THREE.Mesh;
  fromSphere: THREE.Mesh;
  toSphere:   THREE.Mesh;
}

interface HitboxEntry {
  container: THREE.Object3D;
  parts: PartGeo[];
  /** True when the container is owned by a scene (prop), false when parented to entity group. */
  ownedByScene: boolean;
  scene: THREE.Scene | null;
}

/** Convert entity-local (fwd, right, up) → Three.js local (right, up, −fwd). */
function toThree(fwd: number, right: number, up: number): THREE.Vector3 {
  return new THREE.Vector3(right, up, -fwd);
}

function buildParts(hitbox: HitboxData): { container: THREE.Object3D; parts: PartGeo[] } {
  const container = new THREE.Object3D();
  const parts: PartGeo[] = [];

  for (const part of hitbox.parts) {
    const from = toThree(part.fromFwd, part.fromRight, part.fromUp);
    const to   = toThree(part.toFwd,   part.toRight,   part.toUp);
    const r    = part.radius;

    // Line segment
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([
      from.x, from.y, from.z, to.x, to.y, to.z,
    ], 3));
    const line = new THREE.Line(geo, MAT_LINE.clone());
    line.renderOrder = 998;

    // Cylinder hull — orient along the segment axis
    const mid  = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    const len  = from.distanceTo(to);
    const cylinder = new THREE.Mesh(CYLINDER_GEO, MAT_WIRE.clone());
    cylinder.renderOrder = 998;
    cylinder.position.copy(mid);
    cylinder.scale.set(r, len > 0 ? len : 0.001, r);
    // Rotate default Y-axis cylinder to align with from→to
    if (len > 0.0001) {
      const axis = new THREE.Vector3().subVectors(to, from).normalize();
      cylinder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    }

    // Endpoint spheres
    const fromSphere = new THREE.Mesh(SPHERE_GEO, MAT_WIRE.clone());
    fromSphere.position.copy(from);
    fromSphere.scale.setScalar(r);
    fromSphere.renderOrder = 998;

    const toSphere = new THREE.Mesh(SPHERE_GEO, MAT_WIRE.clone());
    toSphere.position.copy(to);
    toSphere.scale.setScalar(r);
    toSphere.renderOrder = 998;

    container.add(line, cylinder, fromSphere, toSphere);
    parts.push({ line, cylinder, fromSphere, toSphere });
  }

  // Assign all objects to the overlay layer so they are excluded from the
  // main pixel-art pass and rendered in the dedicated overlay pass instead.
  container.traverse((obj) => obj.layers.set(HITBOX_OVERLAY_LAYER));

  return { container, parts };
}

export class HitboxDebugOverlay {
  private _visible = false;
  private readonly entries = new Map<string, HitboxEntry>();

  toggle(): boolean {
    this._visible = !this._visible;
    for (const entry of this.entries.values()) {
      entry.container.visible = this._visible;
    }
    return this._visible;
  }

  /** Animated entity — container parented to the entity's mesh group. */
  updateEntity(entityId: string, mesh: EntityMeshGroup, hitbox: HitboxData): void {
    this.removeEntry(entityId);
    const { container, parts } = buildParts(hitbox);
    container.visible = this._visible;
    mesh.group.add(container);
    this.entries.set(entityId, { container, parts, ownedByScene: false, scene: null });
  }

  /**
   * Static prop — container placed at world position directly in scene.
   * Called when the entity transitions to the prop pool.
   */
  updateProp(entityId: string, scene: THREE.Scene, worldPos: THREE.Vector3, hitbox: HitboxData): void {
    this.removeEntry(entityId);
    const { container, parts } = buildParts(hitbox);
    container.position.copy(worldPos);
    container.visible = this._visible;
    scene.add(container);
    this.entries.set(entityId, { container, parts, ownedByScene: true, scene });
  }

  removeEntity(entityId: string): void {
    this.removeEntry(entityId);
  }

  dispose(): void {
    for (const entityId of [...this.entries.keys()]) this.removeEntry(entityId);
  }

  private removeEntry(entityId: string): void {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    if (entry.ownedByScene) {
      entry.scene?.remove(entry.container);
    } else {
      entry.container.parent?.remove(entry.container);
    }
    for (const pg of entry.parts) {
      pg.line.geometry.dispose();
      pg.cylinder.geometry.dispose();
      (pg.line.material       as THREE.Material).dispose();
      (pg.cylinder.material   as THREE.Material).dispose();
      (pg.fromSphere.material as THREE.Material).dispose();
      (pg.toSphere.material   as THREE.Material).dispose();
    }
    this.entries.delete(entityId);
  }
}
