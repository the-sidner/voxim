/// <reference lib="dom" />
/**
 * RoofRenderer (T-066) — flat roof geometry over enclosed interiors.
 *
 * The server (EnclosureSystem, T-065) floods sealed cells tile-wide and has
 * no notion of "one building" — `EnclosureChangedEvent.cells` is a flat list
 * of every currently-enclosed world cell. This renderer groups that list
 * into 4-connected components client-side (one component per physically
 * separate building) and builds one merged-quad mesh per component, the
 * same greedy row-run merge water_renderer.ts uses for its surface quads.
 *
 * The wire event carries the FULL current set, not a diff, so every
 * `onEnclosureChanged` call disposes all previous roof meshes and rebuilds
 * from scratch — simple, and cheap given how rarely walls change (recompute
 * only fires on BuildingCompleted).
 *
 * Hide-when-inside: `updateVisibility` is called every render frame with the
 * player's world position (game.ts, the same call site that drives
 * canopyFade/fog LOS off predicted position). A roof component hides while
 * the player's cell is a member of it — walking inside makes it disappear;
 * walking back out shows it again. Membership is a plain Set lookup, so this
 * costs nothing per component per frame.
 *
 * Height: each cell's roof quad sits at `getTerrainHeight(cell) +
 * roofHeightAboveFloor` (game_config.building, T-066) — the roof reads as
 * resting on top of the walls that seal the enclosure. Cells at different
 * floor heights within one component still merge into per-row runs; only
 * an EXACT height match extends a run, matching water_renderer's convention.
 */
import * as THREE from "three";
import type { ClientWorld } from "../state/client_world.ts";
import { paletteToken } from "./palette.ts";

interface EnclosedCell {
  x: number;
  y: number;
}

/** One flat merged-quad geometry for a connected group of enclosed cells. */
interface RoofPiece {
  mesh: THREE.Mesh;
  /** "x,y" world-cell keys this piece covers — for the per-frame inside test. */
  cells: Set<string>;
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Group cells into 4-connected components (one component per building). */
export function groupConnectedComponents(cells: EnclosedCell[]): EnclosedCell[][] {
  const present = new Set<string>();
  const byKey = new Map<string, EnclosedCell>();
  for (const c of cells) {
    const k = cellKey(c.x, c.y);
    present.add(k);
    byKey.set(k, c);
  }
  const visited = new Set<string>();
  const components: EnclosedCell[][] = [];

  for (const c of cells) {
    const startKey = cellKey(c.x, c.y);
    if (visited.has(startKey)) continue;
    const component: EnclosedCell[] = [];
    const queue: string[] = [startKey];
    visited.add(startKey);
    while (queue.length > 0) {
      const key = queue.pop()!;
      const cell = byKey.get(key)!;
      component.push(cell);
      const neighbours = [
        cellKey(cell.x - 1, cell.y),
        cellKey(cell.x + 1, cell.y),
        cellKey(cell.x, cell.y - 1),
        cellKey(cell.x, cell.y + 1),
      ];
      for (const nk of neighbours) {
        if (present.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
    }
    components.push(component);
  }
  return components;
}

/**
 * Build a merged-quad BufferGeometry for one component. Cells are grouped by
 * row (world Y) and greedily merged into flat runs along X, the same way
 * water_renderer.ts's buildWaterGeo merges its per-cell surface levels — a
 * run only extends while consecutive cells share the exact same roof height.
 */
export function buildRoofGeometry(
  component: EnclosedCell[],
  heightAt: (x: number, y: number) => number,
): THREE.BufferGeometry {
  const byRow = new Map<number, EnclosedCell[]>();
  for (const c of component) {
    let row = byRow.get(c.y);
    if (!row) { row = []; byRow.set(c.y, row); }
    row.push(c);
  }

  const positions: number[] = [];
  const indices: number[] = [];
  let vBase = 0;

  const addQuad = (x0: number, x1: number, z0: number, z1: number, y: number) => {
    positions.push(
      x0, y, z0,
      x1, y, z0,
      x0, y, z1,
      x1, y, z1,
    );
    indices.push(vBase, vBase + 2, vBase + 1, vBase + 1, vBase + 2, vBase + 3);
    vBase += 4;
  };

  for (const [y, row] of byRow) {
    row.sort((a, b) => a.x - b.x);
    let runStart = -1;
    let runX = -1;
    let runHeight = NaN;
    const flush = (endX: number) => {
      if (runStart < 0) return;
      addQuad(runStart, endX + 1, y, y + 1, runHeight);
      runStart = -1;
    };
    for (const cell of row) {
      const h = heightAt(cell.x, cell.y);
      if (runStart >= 0 && (cell.x !== runX + 1 || h !== runHeight)) {
        flush(runX);
      }
      if (runStart < 0) {
        runStart = cell.x;
        runHeight = h;
      }
      runX = cell.x;
    }
    flush(runX);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  geo.computeVertexNormals();
  return geo;
}

export class RoofRenderer {
  private readonly scene: THREE.Scene;
  private readonly world: ClientWorld;
  private readonly material: THREE.Material;
  private readonly roofHeightAboveFloor: number;
  private pieces: RoofPiece[] = [];

  constructor(scene: THREE.Scene, world: ClientWorld, roofHeightAboveFloor: number) {
    this.scene = scene;
    this.world = world;
    this.roofHeightAboveFloor = roofHeightAboveFloor;
    this.material = new THREE.MeshPhongMaterial({
      color: paletteToken("roof"),
      flatShading: true,
      side: THREE.DoubleSide,
    });
  }

  /**
   * Rebuild all roof geometry from the server's full current enclosed-cell
   * set. Called once per EnclosureChanged event.
   */
  onEnclosureChanged(cells: EnclosedCell[]): void {
    this.clear();
    if (cells.length === 0) return;

    const components = groupConnectedComponents(cells);
    for (const component of components) {
      const geo = buildRoofGeometry(
        component,
        (x, y) => this.world.getTerrainHeight(x, y) + this.roofHeightAboveFloor,
      );
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.name = "roof";
      this.scene.add(mesh);
      const cellSet = new Set(component.map((c) => cellKey(c.x, c.y)));
      this.pieces.push({ mesh, cells: cellSet });
    }
  }

  /**
   * Called every render frame with the player's current world position
   * (predicted when available — the canopyFade/fog-LOS call site). Hides
   * whichever roof piece the player's cell belongs to; shows the rest.
   */
  updateVisibility(worldX: number, worldY: number): void {
    if (this.pieces.length === 0) return;
    const key = cellKey(Math.floor(worldX), Math.floor(worldY));
    for (const piece of this.pieces) {
      piece.mesh.visible = !piece.cells.has(key);
    }
  }

  /** Tear down all roof meshes (tile transition or full dispose). */
  clear(): void {
    for (const piece of this.pieces) {
      this.scene.remove(piece.mesh);
      piece.mesh.geometry.dispose();
    }
    this.pieces = [];
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
