/**
 * Upsample a TileInit's sample-grid buffers (gridSize²) to a target cell
 * resolution (targetSize²). Used by tile-server at boot to fit atlas's
 * coarse generation grid into its own finer runtime terrain cell grid —
 * the client's later voxelization of each terrain cell into a stacked
 * column of render voxels is a separate downstream step this function
 * has no awareness of.
 *
 * Sampling rules:
 *
 *   openMask, materials  → NEAREST. The wall edge MUST stay a hard step;
 *                          bilinear smoothing of the binary mask would
 *                          produce a 4-cell ramp the player could climb,
 *                          and material ids aren't blendable anyway.
 *
 *   heightMap            → "nearest with re-added wall step". The atlas
 *                          heightMap already encodes the wall step, so a
 *                          straight bilinear of it would smooth the step
 *                          out. We sample the underlying floor (height
 *                          minus the closed-cell wall contribution)
 *                          bilinearly, then re-add WALL_HEIGHT for any
 *                          target cell whose nearest source cell is
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
import type { FieldPlanes } from "./pipeline/fields.ts";
import { levelToZoneOf } from "./level/types.ts";

/** Nearest-resample a gridSize² plane to targetSize² (T-311 P3). Render fields
 *  are coherent descriptors (not collision) so nearest is correct + NaN-safe for
 *  the f32 water level; bilinear refinement can come later if gradients read blocky. */
function nearestResample<T extends Uint8Array | Float32Array>(src: T, g: number, target: number): T {
  const out = (src instanceof Float32Array ? new Float32Array(target * target) : new Uint8Array(target * target)) as T;
  const ratio = g / target;
  for (let ty = 0; ty < target; ty++) {
    const sy = Math.min(g - 1, Math.max(0, Math.round((ty + 0.5) * ratio - 0.5)));
    for (let tx = 0; tx < target; tx++) {
      const sx = Math.min(g - 1, Math.max(0, Math.round((tx + 0.5) * ratio - 0.5)));
      out[ty * target + tx] = src[sy * g + sx];
    }
  }
  return out;
}

function upsampleFieldPlanes(f: FieldPlanes, g: number, target: number): FieldPlanes {
  return {
    canopyLight: nearestResample(f.canopyLight, g, target),
    corruption:  nearestResample(f.corruption, g, target),
    fertility:   nearestResample(f.fertility, g, target),
    wetness:     nearestResample(f.wetness, g, target),
    overgrowth:  nearestResample(f.overgrowth, g, target),
    wear:        nearestResample(f.wear, g, target),
    variantIndex: nearestResample(f.variantIndex, g, target),
    ruinAge:     nearestResample(f.ruinAge, g, target),
    traffic:     nearestResample(f.traffic, g, target),
    surfaceLevel: nearestResample(f.surfaceLevel, g, target),
  };
}

export interface UpsampleOptions {
  /** Target side length in cells (e.g. 512 for tile-server). */
  targetSize: number;
  /**
   * Atlas material id → consumer material id. Atlas's id 0 (NONE) is
   * passed through to `defaultMaterialId`; any id absent from the map
   * also falls back.
   */
  materialMap: ReadonlyMap<number, number>;
  /** Fallback for atlas ids not present in materialMap. */
  defaultMaterialId: number;
  /**
   * The world's actual wall-step height (GenParams.terrain.wallHeight),
   * used to strip/re-add the wall step during floor bilinear resampling.
   * Must match the value the source tile's heightMap was generated with.
   */
  wallHeight: number;
}

export interface UpsampleOutput {
  /** Float32 heights, length targetSize². Compatible with chunksFromBuffers. */
  heightBuffer: Float32Array;
  /** Translated material ids, length targetSize². */
  materialBuffer: Uint16Array;
  /**
   * Nearest-sampled openMask at target resolution, length targetSize².
   * 1 = open, 0 = closed. Used by phase 4B to drive openMask-based
   * collision in tile-server's physics.
   */
  openBuffer: Uint8Array;
  /**
   * Nearest-sampled boundary-kind ids at target resolution, length
   * targetSize². 0 (OPEN) on open cells; per-kind id on closed cells.
   * Used by phase 4C for per-kind rendering.
   */
  kindBuffer: Uint16Array;
  /**
   * Nearest-sampled zone ids at target resolution (T-211), length
   * targetSize². 0xFFFF for un-zoned cells. Tile-server reads this
   * to map player position → zone for the "You are in:" HUD.
   */
  zoneBuffer: Uint16Array;
  /** T-311 P3 render-field planes, nearest-resampled to targetSize². */
  fields: FieldPlanes;
}

export function upsampleTile(tile: TileInit, options: UpsampleOptions): UpsampleOutput {
  const { targetSize, materialMap, defaultMaterialId, wallHeight } = options;
  const g = tile.gridSize;
  const N = targetSize * targetSize;

  const heightBuffer   = new Float32Array(N);
  const materialBuffer = new Uint16Array(N);
  const openBuffer     = new Uint8Array(N);
  const kindBuffer     = new Uint16Array(N);
  const zoneBuffer     = new Uint16Array(N);

  // Derive gridSize² zoneOf from regions[].cells — regions own their
  // cell set; the per-cell index is derived on demand here so the
  // wire doesn't have to ship it separately.
  const tileZoneOf = levelToZoneOf(tile.level);

  // Source-of-truth floor heights — atlas's heightMap minus the wall step
  // wherever the cell is closed. Lets us bilinear the floor without
  // smoothing the step.
  const floor = new Float32Array(g * g);
  for (let i = 0; i < g * g; i++) {
    floor[i] = tile.openMask[i] === 0
      ? tile.heightMap[i] - wallHeight
      : tile.heightMap[i];
  }

  // Map target cell index → source cell index (nearest), and
  // bilinear-interpolation weights for the floor sample.
  const ratio = g / targetSize;
  for (let ty = 0; ty < targetSize; ty++) {
    // Source y in [0, g). Centred on the cell midpoint so we don't
    // bias toward the upper-left of each source cell.
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

      // Re-add wall step from the nearest cell's openness.
      const wall = tile.openMask[nIdx] === 0 ? wallHeight : 0;
      heightBuffer[tIdx] = fInterp + wall;

      // Material: nearest only, with caller-supplied translation.
      const atlasMatId = tile.materials[nIdx];
      const translated = materialMap.get(atlasMatId);
      materialBuffer[tIdx] = translated ?? defaultMaterialId;

      // Openness + boundary kind: nearest only (hard edges).
      openBuffer[tIdx] = tile.openMask[nIdx];
      kindBuffer[tIdx] = tile.kindOf[nIdx];
      // Zone id (T-211): nearest as well — zones are discrete regions
      // so any interpolation across boundaries would be a bug. Source
      // is the regions-derived `tileZoneOf`, not a wire-shipped field.
      zoneBuffer[tIdx] = tileZoneOf[nIdx];
    }
  }

  const fields = upsampleFieldPlanes(tile.fields, g, targetSize);
  return { heightBuffer, materialBuffer, openBuffer, kindBuffer, zoneBuffer, fields };
}
