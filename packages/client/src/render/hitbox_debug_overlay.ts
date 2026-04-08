/**
 * HitboxDebugOverlay — visualises the server-side Hitbox capsules.
 *
 * Each BodyPartVolume is drawn as a line segment (from → to) with wireframe
 * spheres at both endpoints scaled to the capsule radius. Positions are in
 * entity-local space (fwd=+Y, right=+X, up=+Z) and are rendered in the entity
 * group's local coordinate frame via a child Object3D.
 *
 * Toggle with the "hitbox" debug layer key.
 */
import * as THREE from "three";
import type { EntityMeshGroup } from "./entity_mesh.ts";
import type { HitboxData } from "@voxim/codecs";

// Shared geometry — not disposed per-entry.
const SPHERE_GEO = new THREE.SphereGeometry(1, 6, 4);

const MAT_LINE = new THREE.LineBasicMaterial({
  color: 0x00ffcc, depthTest: false, depthWrite: false,
});
const MAT_SPHERE = new THREE.MeshBasicMaterial({
  color: 0x00ffcc, wireframe: true,
  depthTest: false, depthWrite: false, transparent: true, opacity: 0.5,
});

interface PartGeo {
  line: THREE.Line;
  fromSphere: THREE.Mesh;
  toSphere: THREE.Mesh;
}

interface HitboxEntry {
  container: THREE.Object3D;
  parts: PartGeo[];
}

/** Convert entity-local (fwd, right, up) → Three.js local (x, y, z). */
function toThree(fwd: number, right: number, up: number): THREE.Vector3 {
  // Entity group: pos.x=server.x, pos.y=server.z, pos.z=server.y
  // Entity-local axes: right=+X, up=+Z(server)=+Y(three), fwd=+Y(server)=+Z(three) but entity faces -Z
  // The entity mesh itself is already rotated, so within the group's local frame:
  //   right → +x, up → +y, fwd → -z
  return new THREE.Vector3(right, up, -fwd);
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

  /** Called when an entity's hitbox component changes or entity spawns. */
  updateEntity(entityId: string, mesh: EntityMeshGroup, hitbox: HitboxData): void {
    this.removeEntry(entityId);

    const container = new THREE.Object3D();
    container.visible = this._visible;
    const partGeos: PartGeo[] = [];

    for (const part of hitbox.parts) {
      const from = toThree(part.fromFwd, part.fromRight, part.fromUp);
      const to   = toThree(part.toFwd,   part.toRight,   part.toUp);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute([
        from.x, from.y, from.z,
        to.x,   to.y,   to.z,
      ], 3));
      const line = new THREE.Line(geo, MAT_LINE.clone());
      line.renderOrder = 998;

      const fromSphere = new THREE.Mesh(SPHERE_GEO, MAT_SPHERE.clone());
      fromSphere.position.copy(from);
      fromSphere.scale.setScalar(part.radius);
      fromSphere.renderOrder = 998;

      const toSphere = new THREE.Mesh(SPHERE_GEO, MAT_SPHERE.clone());
      toSphere.position.copy(to);
      toSphere.scale.setScalar(part.radius);
      toSphere.renderOrder = 998;

      container.add(line, fromSphere, toSphere);
      partGeos.push({ line, fromSphere, toSphere });
    }

    mesh.group.add(container);
    this.entries.set(entityId, { container, parts: partGeos });
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
    entry.container.parent?.remove(entry.container);
    for (const pg of entry.parts) {
      pg.line.geometry.dispose();
      (pg.line.material as THREE.Material).dispose();
      (pg.fromSphere.material as THREE.Material).dispose();
      (pg.toSphere.material  as THREE.Material).dispose();
    }
    this.entries.delete(entityId);
  }
}
