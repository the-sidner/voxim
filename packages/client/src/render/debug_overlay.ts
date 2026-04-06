/**
 * Debug overlays — optional visual aids toggled from the debug panel.
 *
 * FacingOverlay   — arrow per entity showing current facing angle.
 * ChunkOverlay    — wireframe box per loaded terrain chunk.
 *
 * Both sit at renderOrder 998 with depthTest:false so they draw on top.
 */
import * as THREE from "three";
import type { EntityMeshGroup } from "./entity_mesh.ts";

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
 * One LineSegments object per entity, updated every frame from bone-group positions.
 */
export class FacingOverlay {
  private readonly scene: THREE.Scene;
  private readonly arrows = new Map<string, THREE.LineSegments>();
  enabled = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    for (const [, arrow] of this.arrows) arrow.visible = this.enabled;
    return this.enabled;
  }

  /** Called after entity positions are updated each frame. */
  update(entityMeshes: Map<string, EntityMeshGroup>): void {
    const seen = new Set<string>();

    for (const [id, mesh] of entityMeshes) {
      seen.add(id);
      if (!this.enabled) continue;

      let arrow = this.arrows.get(id);
      if (!arrow) {
        // Arrow: shaft (0,0,0)→(0,0,-1.5), head left (0,0,-1.5)→(0.3,0,-1.1),
        // head right (0,0,-1.5)→(-0.3,0,-1.1)
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
        arrow.visible = this.enabled;
        this.scene.add(arrow);
        this.arrows.set(id, arrow);
      }

      // Position at entity group world position, at head height.
      // arrow.rotation.y = -facingAngle matches the same convention as
      // updateEntityMesh (group.rotation.y = -facing.angle).
      const pos = mesh.group.position;
      arrow.position.set(pos.x, pos.y + 1.8, pos.z);
      // facingAngle=0 means cursor is to the right (+X screen), but Three.js
      // rotation.y=0 points the arrow toward -Z. That's a quarter-turn offset,
      // so subtract π/2 to rotate clockwise into the correct world direction.
      arrow.rotation.y = -mesh.facingAngle - Math.PI / 2;
    }

    // Remove arrows for entities that no longer exist
    for (const [id, arrow] of this.arrows) {
      if (!seen.has(id)) {
        this.scene.remove(arrow);
        arrow.geometry.dispose();
        this.arrows.delete(id);
      }
    }
  }

  dispose(): void {
    for (const [, arrow] of this.arrows) {
      this.scene.remove(arrow);
      arrow.geometry.dispose();
    }
    this.arrows.clear();
  }
}

// ── Chunk border overlay ──────────────────────────────────────────────────────

/**
 * Draws an orange wireframe border around each loaded terrain chunk.
 * One LineLoop per chunk, rebuilt only when chunks are added/removed.
 */
export class ChunkOverlay {
  private readonly scene: THREE.Scene;
  private readonly borders = new Map<string, THREE.LineLoop>();
  enabled = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    for (const [, b] of this.borders) b.visible = this.enabled;
    return this.enabled;
  }

  addChunk(chunkX: number, chunkY: number): void {
    const key = `${chunkX},${chunkY}`;
    if (this.borders.has(key)) return;

    const wx = chunkX * CHUNK;
    const wz = chunkY * CHUNK;
    const y  = 20; // above max terrain height — depthTest:false makes it visible everywhere

    // Four corners of the chunk in XZ
    const buf = new Float32Array([
      wx,        y, wz,
      wx + CHUNK, y, wz,
      wx + CHUNK, y, wz + CHUNK,
      wx,        y, wz + CHUNK,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(buf, 3));
    const loop = new THREE.LineLoop(geo, MAT_CHUNK);
    loop.renderOrder = 998;
    loop.frustumCulled = false;
    loop.visible = this.enabled;
    this.scene.add(loop);
    this.borders.set(key, loop);
  }

  removeChunk(chunkX: number, chunkY: number): void {
    const key = `${chunkX},${chunkY}`;
    const border = this.borders.get(key);
    if (!border) return;
    this.scene.remove(border);
    border.geometry.dispose();
    this.borders.delete(key);
  }

  dispose(): void {
    for (const [, b] of this.borders) {
      this.scene.remove(b);
      b.geometry.dispose();
    }
    this.borders.clear();
  }
}
