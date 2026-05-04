/**
 * Upsample a TileInit's sample-grid buffers (gridSize²) to a target voxel
 * resolution (targetSize²). Used by tile-server at boot to fit atlas's
 * coarse generation grid into its own finer voxel grid.
 *
 * Sampling rules:
 *
 *   openMask, materials  → NEAREST. The wall edge MUST stay a hard step;
 *                          bilinear smoothing of the binary mask would
 *                          produce a 4-voxel ramp the player could climb,
 *                          and material ids aren't blendable anyway.
 *
 *   heightMap            → "nearest with re-added wall step". The atlas
 *                          heightMap already encodes the wall step, so a
 *                          straight bilinear of it would smooth the step
 *                          out. We sample the underlying floor (height
 *                          minus the closed-pixel wall contribution)
 *                          bilinearly, then re-add WALL_HEIGHT for any
 *                          target voxel whose nearest source pixel is
 *                          closed. Keeps the floor smooth, keeps the
 *                          wall edge sharp.
 *
 * Material translation: tile-server (or any consumer) supplies a Map
 * from atlas's MATERIAL_* ids to the consumer's own material registry
 * ids. Unknown ids fall through to a caller-provided default.
 *
 * Pure function. No I/O.
 */

import type { TileInit } from "./types.ts";
import { WALL_HEIGHT } from "./pipeline/terrain.ts";

export interface UpsampleOptions {
  /** Target side length in voxels (e.g. 512 for tile-server). */
  targetSize: number;
  /**
   * Atlas material id → consumer material id. Atlas's id 0 (NONE) is
   * passed through to `defaultMaterialId`; any id absent from the map
   * also falls back.
   */
  materialMap: ReadonlyMap<number, number>;
  /** Fallback for atlas ids not present in materialMap. */
  defaultMaterialId: number;
}

export interface UpsampleOutput {
  /** Float32 heights, length targetSize². Compatible with chunksFromBuffers. */
  heightBuffer: Float32Array;
  /** Translated material ids, length targetSize². */
  materialBuffer: Uint16Array;
}

export function upsampleTile(tile: TileInit, options: UpsampleOptions): UpsampleOutput {
  const { targetSize, materialMap, defaultMaterialId } = options;
  const g = tile.gridSize;
  const N = targetSize * targetSize;

  const heightBuffer   = new Float32Array(N);
  const materialBuffer = new Uint16Array(N);

  // Source-of-truth floor heights — atlas's heightMap minus the wall step
  // wherever the pixel is closed. Lets us bilinear the floor without
  // smoothing the step.
  const floor = new Float32Array(g * g);
  for (let i = 0; i < g * g; i++) {
    floor[i] = tile.openMask[i] === 0
      ? tile.heightMap[i] - WALL_HEIGHT
      : tile.heightMap[i];
  }

  // Map target voxel index → source pixel index (nearest), and
  // bilinear-interpolation weights for the floor sample.
  const ratio = g / targetSize;
  for (let ty = 0; ty < targetSize; ty++) {
    // Source y in [0, g). Centred on the voxel midpoint so we don't
    // bias toward the upper-left of each source pixel.
    const sy = (ty + 0.5) * ratio - 0.5;
    const sy0 = Math.max(0, Math.floor(sy));
    const sy1 = Math.min(g - 1, sy0 + 1);
    const fy  = Math.max(0, Math.min(1, sy - sy0));
    const syn = fy > 0.5 ? sy1 : sy0; // nearest

    for (let tx = 0; tx < targetSize; tx++) {
      const sx = (tx + 0.5) * ratio - 0.5;
      const sx0 = Math.max(0, Math.floor(sx));
      const sx1 = Math.min(g - 1, sx0 + 1);
      const fx  = Math.max(0, Math.min(1, sx - sx0));
      const sxn = fx > 0.5 ? sx1 : sx0; // nearest

      const nIdx = syn * g + sxn;
      const tIdx = ty  * targetSize + tx;

      // Bilinear floor.
      const f00 = floor[sy0 * g + sx0];
      const f10 = floor[sy0 * g + sx1];
      const f01 = floor[sy1 * g + sx0];
      const f11 = floor[sy1 * g + sx1];
      const fInterp =
        f00 * (1 - fx) * (1 - fy) +
        f10 * fx       * (1 - fy) +
        f01 * (1 - fx) * fy +
        f11 * fx       * fy;

      // Re-add wall step from the nearest pixel's openness.
      const wall = tile.openMask[nIdx] === 0 ? WALL_HEIGHT : 0;
      heightBuffer[tIdx] = fInterp + wall;

      // Material: nearest only, with caller-supplied translation.
      const atlasMatId = tile.materials[nIdx];
      const translated = materialMap.get(atlasMatId);
      materialBuffer[tIdx] = translated ?? defaultMaterialId;
    }
  }

  return { heightBuffer, materialBuffer };
}
