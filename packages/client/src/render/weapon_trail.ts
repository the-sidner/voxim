/**
 * Weapon tip trail ribbons (extracted from VoximRenderer, T-282). Owns its own
 * per-entity slice buffers + ribbon meshes and the scene layer they live on; the
 * renderer just feeds it `(entityMeshes, weaponActions, now)` once per frame.
 *
 * Each active-phase frame records a blade slice (world hilt→tip + perpendicular
 * half-width); slices decay and are rebuilt into a closed swept-volume tube.
 * Color comes from the single palette (`trail` token).
 */
import * as THREE from "three";
import type { WeaponActionDef } from "@voxim/content";
import type { EntityMeshGroup } from "./entity_mesh.ts";
import { evaluateBladeWorld } from "./skeleton_evaluator.ts";
import { paletteToken } from "./palette.ts";

/**
 * One recorded frame of the weapon blade during an attack's active phase — the
 * world-space blade segment (hilt → tip) plus a perpendicular direction and
 * half-width so the trail can render the full swept volume.
 */
interface TrailSlice {
  hiltX: number; hiltY: number; hiltZ: number;
  tipX: number; tipY: number; tipZ: number;
  perpX: number; perpY: number; perpZ: number;
  halfW: number;
  alpha: number;
}

export class WeaponTrailRenderer {
  private readonly slices = new Map<string, TrailSlice[]>();
  private readonly meshes = new Map<string, THREE.Mesh>();

  constructor(private readonly scene: THREE.Scene) {}

  /**
   * Append a slice for each entity in its attack's active phase, decay existing
   * slices, and rebuild the ribbon meshes. Called once per frame before draw.
   */
  update(
    entityMeshes: ReadonlyMap<string, EntityMeshGroup>,
    weaponActions: Map<string, WeaponActionDef>,
    now: number,
  ): void {
    for (const [entityId, mesh] of entityMeshes) {
      const anim = mesh.animationState;
      if (!anim || !anim.weaponActionId) {
        // Decay-only: let an existing trail finish fading after the attack ends.
        const slices = this.slices.get(entityId);
        if (slices && slices.length > 0) {
          for (const s of slices) s.alpha -= 0.04;
          this.slices.set(entityId, slices.filter((s) => s.alpha > 0));
          this.rebuild(entityId);
        }
        continue;
      }

      const weaponAction = weaponActions.get(anim.weaponActionId);
      const elapsed = (now - mesh.lastAnimUpdateMs) / 50;
      const total = weaponAction
        ? weaponAction.windupTicks + weaponAction.activeTicks + weaponAction.winddownTicks
        : 0;
      const ticks = Math.min(anim.ticksIntoAction + elapsed, total);
      const inActive = weaponAction
        ? ticks >= weaponAction.windupTicks && ticks < weaponAction.windupTicks + weaponAction.activeTicks
        : false;

      let slices = this.slices.get(entityId) ?? [];

      const blade = weaponAction?.blade;
      const holdBone = weaponAction?.holdHand ?? "hand_r";
      // Force the entity matrix recompute so the bone matrixWorld evaluateBladeWorld
      // reads reflects this frame's pose (this runs before the renderer's own pass).
      if (inActive && blade) mesh.group.updateWorldMatrix(true, false);
      const bw = inActive && blade ? evaluateBladeWorld(mesh, blade, holdBone) : null;

      if (bw) {
        const halfW = mesh.bladeDimensions?.halfCross ?? 0.1;
        const wHilt = bw.base;
        const wTip = bw.tip;
        // Perpendicular to the blade in the horizontal plane — the trail width.
        const bx = wTip.x - wHilt.x, by = wTip.y - wHilt.y, bz = wTip.z - wHilt.z;
        void by;
        const bLen = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
        let px = bz / bLen, pz = -bx / bLen;
        const pLen = Math.sqrt(px * px + pz * pz) || 1;
        px /= pLen; pz /= pLen;

        slices.push({
          hiltX: wHilt.x, hiltY: wHilt.y, hiltZ: wHilt.z,
          tipX: wTip.x, tipY: wTip.y, tipZ: wTip.z,
          perpX: px, perpY: 0, perpZ: pz,
          halfW, alpha: 0.5,
        });
      }

      for (const s of slices) s.alpha -= 0.04;
      slices = slices.filter((s) => s.alpha > 0);
      this.slices.set(entityId, slices);
      this.rebuild(entityId);
    }

    // Drop trail meshes for entities no longer present.
    for (const [entityId] of this.meshes) {
      if (!entityMeshes.has(entityId)) this.remove(entityId);
    }
  }

  /** Rebuild the swept-volume tube from the current slice buffer. */
  private rebuild(entityId: string): void {
    const slices = this.slices.get(entityId) ?? [];

    if (slices.length < 2) {
      const existing = this.meshes.get(entityId);
      if (existing) {
        this.scene.remove(existing);
        existing.geometry.dispose();
        (existing.material as THREE.Material).dispose();
        this.meshes.delete(entityId);
      }
      return;
    }

    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    // Trail color from the single palette (T-280). Hilt darkens slightly toward
    // the base for the swept-flame gradient; tip is the full token color.
    const tc = new THREE.Color(paletteToken("trail"));
    const hr = tc.r * 0.85, hg = tc.g * 0.85, hb = tc.b * 0.85;

    // 4 verts per slice: hiltL, hiltR, tipR, tipL.
    for (let i = 0; i < slices.length; i++) {
      const s = slices[i];
      const a = s.alpha;
      positions.push(s.hiltX - s.perpX * s.halfW, s.hiltY, s.hiltZ - s.perpZ * s.halfW);
      colors.push(hr, hg, hb, a * 0.6);
      positions.push(s.hiltX + s.perpX * s.halfW, s.hiltY, s.hiltZ + s.perpZ * s.halfW);
      colors.push(hr, hg, hb, a * 0.6);
      positions.push(s.tipX + s.perpX * s.halfW, s.tipY, s.tipZ + s.perpZ * s.halfW);
      colors.push(tc.r, tc.g, tc.b, a);
      positions.push(s.tipX - s.perpX * s.halfW, s.tipY, s.tipZ - s.perpZ * s.halfW);
      colors.push(tc.r, tc.g, tc.b, a);
    }

    // Between consecutive slices: 4 faces forming a closed tube.
    for (let i = 0; i < slices.length - 1; i++) {
      const b0 = i * 4, b1 = (i + 1) * 4;
      const hL0 = b0, hR0 = b0 + 1, tR0 = b0 + 2, tL0 = b0 + 3;
      const hL1 = b1, hR1 = b1 + 1, tR1 = b1 + 2, tL1 = b1 + 3;
      indices.push(hL0, hL1, tL1, hL0, tL1, tL0); // left side
      indices.push(hR0, tR0, tR1, hR0, tR1, hR1); // right side
      indices.push(hL0, hR0, hR1, hL0, hR1, hL1); // near (hilt) face
      indices.push(tL0, tR1, tR0, tL0, tL1, tR1); // far (tip) face
    }

    let trailMesh = this.meshes.get(entityId);
    if (!trailMesh) {
      const geo = new THREE.BufferGeometry();
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      trailMesh = new THREE.Mesh(geo, mat);
      this.scene.add(trailMesh);
      this.meshes.set(entityId, trailMesh);
    }

    const geo = trailMesh.geometry;
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
  }

  private remove(entityId: string): void {
    const mesh = this.meshes.get(entityId);
    if (mesh) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.meshes.delete(entityId);
    }
    this.slices.delete(entityId);
  }

  dispose(): void {
    for (const id of [...this.meshes.keys()]) this.remove(id);
  }
}
