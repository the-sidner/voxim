/**
 * Debug overlays — optional visual aids toggled from the debug panel.
 *
 * FacingOverlay   — arrow per entity showing current facing angle.
 * ChunkOverlay    — wireframe box per loaded terrain chunk.
 *
 * Both implement ManagedOverlay and are registered in the DebugOverlayManager.
 * ChunkOverlay is also accessed directly via manager.get<ChunkOverlay>("chunks")
 * for event-driven addChunk / removeChunk calls from the renderer.
 */
import * as THREE from "three";
import type { ManagedOverlay, DebugUpdateContext } from "./debug_overlay_manager.ts";

const CHUNK = 32;

// ---- shared materials ----

const MAT_FACING = new THREE.LineBasicMaterial({
  color: 0x00ffff,
  depthTest: false,
  depthWrite: false,
});

const MAT_CHUNK = new THREE.LineBasicMaterial({
  color: 0xffaa00,
  depthTest: false,
  depthWrite: false,
});

// ── Facing overlay ────────────────────────────────────────────────────────────

/**
 * Draws a short cyan arrow pointing in each entity's facing direction.
 */
export class FacingOverlay implements ManagedOverlay {
  private readonly scene: THREE.Scene;
  private readonly arrows = new Map<string, THREE.LineSegments>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  onToggle(on: boolean): void {
    for (const arrow of this.arrows.values()) arrow.visible = on;
  }

  update(ctx: DebugUpdateContext): void {
    const seen = new Set<string>();

    for (const [id, mesh] of ctx.entityMeshes) {
      seen.add(id);
      let arrow = this.arrows.get(id);
      if (!arrow) {
        const buf = new Float32Array([
          0, 0, 0,    0, 0, -1.5,
          0, 0, -1.5, 0.3, 0, -1.1,
          0, 0, -1.5, -0.3, 0, -1.1,
        ]);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(buf, 3));
        arrow = new THREE.LineSegments(geo, MAT_FACING);
        arrow.renderOrder = 998;
        arrow.frustumCulled = false;
        this.scene.add(arrow);
        this.arrows.set(id, arrow);
      }

      const pos = mesh.group.position;
      arrow.position.set(pos.x, pos.y + 1.8, pos.z);
      arrow.rotation.y = -mesh.facingAngle - Math.PI / 2;
      arrow.visible = true;
    }

    for (const [id, arrow] of this.arrows) {
      if (!seen.has(id)) {
        this.scene.remove(arrow);
        arrow.geometry.dispose();
        this.arrows.delete(id);
      }
    }
  }

  removeEntity(entityId: string): void {
    const arrow = this.arrows.get(entityId);
    if (!arrow) return;
    this.scene.remove(arrow);
    arrow.geometry.dispose();
    this.arrows.delete(entityId);
  }

  dispose(): void {
    for (const arrow of this.arrows.values()) {
      this.scene.remove(arrow);
      arrow.geometry.dispose();
    }
    this.arrows.clear();
  }
}

// ── Chunk border overlay ──────────────────────────────────────────────────────

/**
 * Draws an orange wireframe border around each loaded terrain chunk.
 * addChunk / removeChunk are called directly from the renderer when terrain changes.
 * update() is a no-op — chunk borders only change on terrain events.
 */
export class ChunkOverlay implements ManagedOverlay {
  private readonly scene: THREE.Scene;
  private readonly borders = new Map<string, THREE.LineLoop>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  onToggle(on: boolean): void {
    for (const b of this.borders.values()) b.visible = on;
  }

  // Called from the renderer when a terrain chunk is loaded.
  addChunk(chunkX: number, chunkY: number, visible: boolean): void {
    const key = `${chunkX},${chunkY}`;
    if (this.borders.has(key)) return;

    const wx = chunkX * CHUNK;
    const wz = chunkY * CHUNK;
    const y  = 20;

    const buf = new Float32Array([
      wx,         y, wz,
      wx + CHUNK, y, wz,
      wx + CHUNK, y, wz + CHUNK,
      wx,         y, wz + CHUNK,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(buf, 3));
    const loop = new THREE.LineLoop(geo, MAT_CHUNK);
    loop.renderOrder = 998;
    loop.frustumCulled = false;
    loop.visible = visible;
    this.scene.add(loop);
    this.borders.set(key, loop);
  }

  // Called from the renderer when a terrain chunk is unloaded.
  removeChunk(chunkX: number, chunkY: number): void {
    const key = `${chunkX},${chunkY}`;
    const border = this.borders.get(key);
    if (!border) return;
    this.scene.remove(border);
    border.geometry.dispose();
    this.borders.delete(key);
  }

  // Chunk borders don't change per-frame — update is a no-op.
  update(_ctx: DebugUpdateContext): void {}

  removeEntity(_entityId: string): void {}

  dispose(): void {
    for (const b of this.borders.values()) {
      this.scene.remove(b);
      b.geometry.dispose();
    }
    this.borders.clear();
  }
}
