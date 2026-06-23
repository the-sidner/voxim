/**
 * BuildGhostRenderer (T-284) — translucent preview of the voxels the brush will
 * place. Subscribes to modeState + cursorVoxelState; rebakes on change.
 *
 * The ghost geometry now comes through the SAME bakeVoxels kitchen as props and
 * terrain, so the preview's displaced-box silhouette matches what actually
 * commits — single tool bakes one voxel at the cursor column's top; the line
 * tool bakes one merged mesh of voxels along the shared brushCells list, each
 * sitting on ITS OWN column top (stair-steps across slopes / pre-stacked cells).
 *
 * Only the geometry is the real kitchen; the shading is a flat translucent
 * palette 'ghost' tint so it reads unambiguously as a preview, not a placed block.
 */
import * as THREE from "three";
import { effect } from "@preact/signals";
import { snapHeight } from "@voxim/world";
import { modeState, cursorVoxelState } from "../input/context.ts";
import { brushCells, type Cell } from "../input/build_line.ts";
import type { VoxelAtom } from "@voxim/content";
import { bakeVoxels } from "./voxel_bake.ts";
import { geometryFromBaked } from "./voxel_geo.ts";
import { paletteToken } from "./palette.ts";

const GHOST_OPACITY = 0.35;
/** All ghost atoms share one material id — the ghost is tinted uniformly. */
const GHOST_MAT_ID = 0;

export class BuildGhostRenderer {
  private readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly disposeEffect: () => void;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly getTerrainHeight: (wx: number, wy: number) => number,
    private readonly getStackHeight: (cellX: number, cellY: number) => number,
  ) {
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: GHOST_OPACITY,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.visible = false;
    this.mesh.name = "build-ghost";
    this.scene.add(this.mesh);
    this.disposeEffect = effect(() => this._update());
  }

  private _update(): void {
    const mode = modeState.value;
    const hit = cursorVoxelState.value;
    if (mode.kind !== "build" || !hit) {
      this.mesh.visible = false;
      return;
    }
    // Tint from the single palette (T-280) on each show, so it's correct even if
    // the palette arrived after this renderer was constructed.
    this.mat.color.setHex(paletteToken("ghost"));

    const voxelSize = mode.brush.voxelSize;
    const cells: Cell[] = brushCells(mode.brush, mode.line?.anchor ?? null, hit);

    // One atom per ghost cell, each at its OWN column top (per-cell baseZ + stack).
    const atoms: VoxelAtom[] = cells.map((c) => {
      const baseZ = snapHeight(this.getTerrainHeight(c.cellX + 0.5, c.cellY + 0.5));
      const layer = this.getStackHeight(c.cellX, c.cellY);
      const placeZ = baseZ + layer * voxelSize + voxelSize / 2;
      return {
        cx: c.cellX + 0.5,  // model east
        cy: c.cellY + 0.5,  // model south
        cz: placeZ,         // model up (height)
        sx: voxelSize, sy: voxelSize, sz: voxelSize,
        materialId: GHOST_MAT_ID,
      };
    });

    // Rebake the merged geometry (cheap — a handful of voxels); the baked
    // positions are absolute world/three coords, so the mesh stays at origin.
    const baked = bakeVoxels(atoms, GHOST_MAT_ID);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geometryFromBaked(baked);
    this.mesh.visible = true;
  }

  dispose(): void {
    this.disposeEffect();
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
