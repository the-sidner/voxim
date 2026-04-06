/**
 * BladeDebugOverlay — live visualisation of the weapon blade capsule.
 *
 * Renders the exact hilt→tip segment and endpoint spheres (at blade radius)
 * that the server's ActionSystem uses for hit detection.  The same
 * evaluateWeaponSlice + matrixWorld transform used by the trail system drives
 * the positions, so what you see is a faithful real-time projection of the
 * server hitbox onto the client scene.
 *
 * Phase colours:
 *   windup   — yellow  (blade not yet active)
 *   active   — red     (hits register this phase)
 *   winddown — orange  (swing cooling down)
 *
 * Wireframe spheres at hilt and tip show the capsule radius.
 * All geometry has depthTest:false so it draws over terrain and entities.
 */
import * as THREE from "three";
import type { EntityMeshGroup } from "./entity_mesh.ts";
import type { WeaponActionDef } from "@voxim/content";
import { evaluateWeaponSlice } from "./skeleton_evaluator.ts";

const COL_WINDUP   = new THREE.Color(1.0, 0.85, 0.0); // yellow
const COL_ACTIVE   = new THREE.Color(1.0, 0.08, 0.08); // red
const COL_WINDDOWN = new THREE.Color(1.0, 0.45, 0.0); // orange

/** One entity's visual blade representation. */
interface BladeEntry {
  /** Segment from hilt to tip. */
  line: THREE.Line;
  /** Wireframe sphere at hilt (scaled to blade radius). */
  hiltSphere: THREE.Mesh;
  /** Wireframe sphere at tip (scaled to blade radius). */
  tipSphere: THREE.Mesh;
}

// Shared unit sphere — cloned material per entry, shared geometry.
const SPHERE_GEO = new THREE.SphereGeometry(1, 8, 6);

export class BladeDebugOverlay {
  private _visible = false;
  private readonly scene: THREE.Scene;
  private readonly entries = new Map<string, BladeEntry>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  get visible(): boolean { return this._visible; }

  toggle(): boolean {
    this._visible = !this._visible;
    if (!this._visible) this.hideAll();
    return this._visible;
  }

  /** Called every render frame — updates positions and colours for all attacking entities. */
  update(
    entityMeshes: Map<string, EntityMeshGroup>,
    weaponActionsMap: Map<string, WeaponActionDef>,
    now: number,
  ): void {
    if (!this._visible) return;

    const seen = new Set<string>();

    for (const [entityId, mesh] of entityMeshes) {
      const anim = mesh.animationState;
      if (!anim || anim.mode !== "attack") continue;

      const weaponAction = weaponActionsMap.get(anim.attackStyle);
      const keyframes = weaponAction?.swingPath?.keyframes;
      if (!keyframes?.length) continue;

      const elapsed = (now - mesh.lastAnimUpdateMs) / 50;
      const total   = anim.windupTicks + anim.activeTicks + anim.winddownTicks;
      const ticks   = Math.min(anim.ticksIntoAction + elapsed, total);
      const t       = total > 0 ? ticks / total : 0;

      const bladeLength = weaponAction!.swingPath.defaultBladeLength ?? 1.0;
      const bladeRadius = weaponAction!.swingPath.defaultBladeRadius  ?? 0.05;

      const local = evaluateWeaponSlice(keyframes, t, bladeLength);

      // Force world matrix recompute (same as trail system does).
      mesh.group.updateWorldMatrix(true, false);
      const mat = mesh.group.matrixWorld;

      const worldHilt = new THREE.Vector3(local.hiltX, local.hiltY, local.hiltZ).applyMatrix4(mat);
      const worldTip  = new THREE.Vector3(local.tipX,  local.tipY,  local.tipZ ).applyMatrix4(mat);

      // Phase colour
      let color: THREE.Color;
      if (ticks < anim.windupTicks)                           color = COL_WINDUP;
      else if (ticks < anim.windupTicks + anim.activeTicks)  color = COL_ACTIVE;
      else                                                    color = COL_WINDDOWN;

      let entry = this.entries.get(entityId);
      if (!entry) {
        entry = this.createEntry();
        this.entries.set(entityId, entry);
        this.scene.add(entry.line, entry.hiltSphere, entry.tipSphere);
      }

      // Update segment
      const positions = entry.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      positions.setXYZ(0, worldHilt.x, worldHilt.y, worldHilt.z);
      positions.setXYZ(1, worldTip.x,  worldTip.y,  worldTip.z);
      positions.needsUpdate = true;
      entry.line.geometry.computeBoundingSphere();
      (entry.line.material as THREE.LineBasicMaterial).color.copy(color);
      entry.line.visible = true;

      // Update endpoint spheres (scaled to capsule radius)
      entry.hiltSphere.position.copy(worldHilt);
      entry.hiltSphere.scale.setScalar(bladeRadius);
      (entry.hiltSphere.material as THREE.MeshBasicMaterial).color.copy(color);
      entry.hiltSphere.visible = true;

      entry.tipSphere.position.copy(worldTip);
      entry.tipSphere.scale.setScalar(bladeRadius);
      (entry.tipSphere.material as THREE.MeshBasicMaterial).color.copy(color);
      entry.tipSphere.visible = true;

      seen.add(entityId);
    }

    // Hide entries for entities no longer attacking
    for (const [entityId, entry] of this.entries) {
      if (!seen.has(entityId)) {
        entry.line.visible = false;
        entry.hiltSphere.visible = false;
        entry.tipSphere.visible = false;
      }
    }
  }

  /** Remove the overlay for a specific entity (called on entity removal). */
  remove(entityId: string): void {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    this.scene.remove(entry.line, entry.hiltSphere, entry.tipSphere);
    entry.line.geometry.dispose();
    (entry.line.material     as THREE.Material).dispose();
    (entry.hiltSphere.material as THREE.Material).dispose();
    (entry.tipSphere.material  as THREE.Material).dispose();
    this.entries.delete(entityId);
  }

  dispose(): void {
    for (const entityId of [...this.entries.keys()]) this.remove(entityId);
    // SPHERE_GEO is module-level — do not dispose here.
  }

  // ---- helpers ----

  private createEntry(): BladeEntry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0xff0000, depthTest: false, depthWrite: false }),
    );
    line.renderOrder = 999;

    const hiltSphere = new THREE.Mesh(
      SPHERE_GEO,
      new THREE.MeshBasicMaterial({
        color: 0xff0000, wireframe: true,
        depthTest: false, depthWrite: false, transparent: true, opacity: 0.6,
      }),
    );
    hiltSphere.renderOrder = 999;

    const tipSphere = new THREE.Mesh(
      SPHERE_GEO,
      new THREE.MeshBasicMaterial({
        color: 0xff0000, wireframe: true,
        depthTest: false, depthWrite: false, transparent: true, opacity: 0.6,
      }),
    );
    tipSphere.renderOrder = 999;

    return { line, hiltSphere, tipSphere };
  }

  private hideAll(): void {
    for (const entry of this.entries.values()) {
      entry.line.visible = false;
      entry.hiltSphere.visible = false;
      entry.tipSphere.visible = false;
    }
  }
}
