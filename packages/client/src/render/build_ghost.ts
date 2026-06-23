/**
 * BuildGhostRenderer — translucent preview of where the next blueprint will
 * land. Subscribes to modeState + cursorCellState; redraws on signal change.
 *
 * Single-tool blueprints render one ghost block at the cursor cell.
 * Polyline blueprints render a chain of ghosts along the Bresenham line from
 * the staged anchor to the cursor cell, so the player can see the whole wall
 * before committing.
 *
 * Three.js coordinate mapping mirrors the rest of the renderer:
 *   world(x, y, z) → three(x, z, y).
 *
 * The ghost reads terrain height via the supplied callback so each cell sits
 * on the ground rather than at z=0.
 */
import * as THREE from "three";
import { effect } from "@preact/signals";
import { modeState, cursorCellState, type WorldCell } from "../input/context.ts";
import { paletteToken } from "./palette.ts";

const GHOST_COLOR = 0xe8c860;
const GHOST_OPACITY = 0.35;
const GHOST_HEIGHT = 1.0;

export class BuildGhostRenderer {
  private readonly group = new THREE.Group();
  private readonly geom = new THREE.BoxGeometry(1, GHOST_HEIGHT, 1);
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly disposeEffect: () => void;
  /** Pool of meshes reused across redraws to keep GC churn low. */
  private readonly pool: THREE.Mesh[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly getTerrainHeight: (wx: number, wy: number) => number,
  ) {
    this.mat = new THREE.MeshBasicMaterial({
      color: GHOST_COLOR,
      transparent: true,
      opacity: GHOST_OPACITY,
      depthWrite: false,
    });
    this.scene.add(this.group);
    this.disposeEffect = effect(() => this._update());
  }

  private _update(): void {
    const mode = modeState.value;
    const cell = cursorCellState.value;
    if (mode.kind !== "build" || !cell) {
      this._setCount(0);
      return;
    }
    // Tint from the single palette (T-280) — set on show so it's correct
    // regardless of whether the palette arrived before this renderer was built.
    this.mat.color.setHex(paletteToken("ghost"));

    const cells: WorldCell[] = [cell];
    if (mode.tool === "polyline" && mode.polyline) {
      const a = mode.polyline.lastAnchor;
      cells.length = 0;
      cells.push(a);
      for (const c of bresenhamCells(a, cell)) cells.push(c);
    }

    this._setCount(cells.length);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const wx = c.cellX + 0.5;
      const wy = c.cellY + 0.5;
      const h = this.getTerrainHeight(wx, wy);
      const mesh = this.group.children[i] as THREE.Mesh;
      mesh.position.set(wx, h + GHOST_HEIGHT / 2, wy);
    }
  }

  private _setCount(n: number): void {
    while (this.group.children.length < n) {
      const m = this.pool.pop() ?? new THREE.Mesh(this.geom, this.mat);
      this.group.add(m);
    }
    while (this.group.children.length > n) {
      const m = this.group.children[this.group.children.length - 1] as THREE.Mesh;
      this.group.remove(m);
      this.pool.push(m);
    }
  }

  dispose(): void {
    this.disposeEffect();
    this.scene.remove(this.group);
    this.geom.dispose();
    this.mat.dispose();
  }
}

/** Bresenham line in cell space, exclusive of the start cell. */
function bresenhamCells(a: WorldCell, b: WorldCell): WorldCell[] {
  const cells: WorldCell[] = [];
  let x0 = a.cellX, y0 = a.cellY;
  const x1 = b.cellX, y1 = b.cellY;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let first = true;
  while (true) {
    if (!first) cells.push({ cellX: x0, cellY: y0 });
    first = false;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return cells;
}
