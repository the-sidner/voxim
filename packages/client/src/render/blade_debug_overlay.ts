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
 *
 * Implements ManagedOverlay — registered in DebugOverlayManager as "blade".
 */
import * as THREE from "three";
import type { ManagedOverlay, DebugUpdateContext } from "./debug_overlay_manager.ts";
import { evaluateWeaponSlice } from "./skeleton_evaluator.ts";

const COL_WINDUP   = new THREE.Color(1.0, 0.85, 0.0);
const COL_ACTIVE   = new THREE.Color(1.0, 0.08, 0.08);
const COL_WINDDOWN = new THREE.Color(1.0, 0.45, 0.0);

interface BladeEntry {
  line: THREE.Line;
  hiltSphere: THREE.Mesh;
  tipSphere: THREE.Mesh;
}

const SPHERE_GEO = new THREE.SphereGeometry(1, 8, 6);

export class BladeDebugOverlay implements ManagedOverlay {
  private readonly scene: THREE.Scene;
  private readonly entries = new Map<string, BladeEntry>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  onToggle(on: boolean): void {
    if (!on) this.hideAll();
  }

  update(ctx: DebugUpdateContext): void {
    const seen = new Set<string>();

    for (const [entityId, mesh] of ctx.entityMeshes) {
      const anim = mesh.animationState;
      if (!anim || !anim.weaponActionId) continue;

      const weaponAction = ctx.weaponActionsMap.get(anim.weaponActionId);
      const keyframes = weaponAction?.swingPath?.keyframes;
      if (!keyframes?.length) continue;

      const elapsed = (ctx.now - mesh.lastAnimUpdateMs) / 50;
      const total   = weaponAction
        ? weaponAction.windupTicks + weaponAction.activeTicks + weaponAction.winddownTicks
        : 0;
      const ticks   = Math.min(anim.ticksIntoAction + elapsed, total);
      const t       = total > 0 ? ticks / total : 0;

      const bladeLength = mesh.bladeDimensions?.length    ?? 1.0;
      const bladeRadius = mesh.bladeDimensions?.halfCross ?? 0.05;

      const local = evaluateWeaponSlice(keyframes, t, bladeLength);

      mesh.group.updateWorldMatrix(true, false);
      const mat = mesh.group.matrixWorld;

      const worldHilt = new THREE.Vector3(local.hiltX, local.hiltY, local.hiltZ).applyMatrix4(mat);
      const worldTip  = new THREE.Vector3(local.tipX,  local.tipY,  local.tipZ ).applyMatrix4(mat);

      let color: THREE.Color;
      if (!weaponAction || ticks < weaponAction.windupTicks)                                          color = COL_WINDUP;
      else if (ticks < weaponAction.windupTicks + weaponAction.activeTicks) color = COL_ACTIVE;
      else                                                                   color = COL_WINDDOWN;

      let entry = this.entries.get(entityId);
      if (!entry) {
        entry = this.createEntry();
        this.entries.set(entityId, entry);
        this.scene.add(entry.line, entry.hiltSphere, entry.tipSphere);
      }

      const positions = entry.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      positions.setXYZ(0, worldHilt.x, worldHilt.y, worldHilt.z);
      positions.setXYZ(1, worldTip.x,  worldTip.y,  worldTip.z);
      positions.needsUpdate = true;
      entry.line.geometry.computeBoundingSphere();
      (entry.line.material as THREE.LineBasicMaterial).color.copy(color);
      entry.line.visible = true;

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

    for (const [entityId, entry] of this.entries) {
      if (!seen.has(entityId)) {
        entry.line.visible = false;
        entry.hiltSphere.visible = false;
        entry.tipSphere.visible = false;
      }
    }
  }

  removeEntity(entityId: string): void {
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
    for (const entityId of [...this.entries.keys()]) this.removeEntity(entityId);
  }

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
