/**
 * Stage 4 — terrain heightmap.
 *
 * Phase 6A scope: produce a height field at sample-grid resolution that
 * tile-server can drive its visible terrain from in a later phase.
 *
 * Two contributions per pixel:
 *   1. Wall baseline. Closed pixels (openMask = 0) rise by WALL_HEIGHT
 *      from the floor — high enough that the runtime physics stepHeight
 *      can't auto-clear them, so they read as boundaries. Nearest-only
 *      sampling at consumption time prevents the wall edge from
 *      averaging into a climbable ramp.
 *   2. Smooth modulation. Low-amplitude fbm shaped by biome.ruggedness
 *      and biome.altitude — gives floors gentle variation without
 *      breaking the open/closed step.
 *
 * Pure function: same (openMask, biome, tileSeed, gridSize) → same
 * Float32Array.
 */

import { fbm } from "../../common/noise.ts";
import type { BiomeParams } from "../../worldmap/types.ts";
import type { GenParams } from "../../genparams.ts";
import { BOUNDARY_KIND_CLIFF } from "./boundary_kinds.ts";

export interface TerrainInput {
  openMask: Uint8Array;
  /**
   * Per-pixel boundary kind from the kinds stage (BOUNDARY_KIND_*).
   * Only CLIFF pixels add the wallHeight step — other closed kinds
   * (vegetation, water, …) stay at floor height. Collision still
   * blocks them via the openMask path in tile-server's physics.
   */
  kindOf: Uint16Array;
  biome: BiomeParams;
  tileSeed: number;
  gridSize: number;
  params: GenParams["terrain"];
}

export interface TerrainOutput {
  /** Float32 heights, length gridSize², row-major. World units. */
  heightMap: Float32Array;
}

/**
 * Default vertical step at every wall pixel — exposed for downstream
 * consumers that need a stable constant (e.g. tile-server's upsampler
 * pre-removes the step before bilinear resampling). Per-world tuning
 * comes through GenParams.terrain.wallHeight; this default mirrors it.
 */
export const WALL_HEIGHT = 3.0;

const TERRAIN_SUB_SEED = 0x40004001;

export function runTerrain(input: TerrainInput): TerrainOutput {
  const { openMask, kindOf, biome, tileSeed, gridSize, params } = input;
  const N = gridSize * gridSize;
  const heightMap = new Float32Array(N);

  // Floor modulation: lower baseline at low altitudes, higher at high.
  // Ruggedness scales the amplitude — flat plains vs. rolling hills.
  const floorBias = (biome.altitude - 0.5) * 4; // ~[-2, +2]
  const modAmp    = params.floorModAmplitude * biome.ruggedness;
  const modFreq   = params.floorModFrequency;

  for (let py = 0; py < gridSize; py++) {
    for (let px = 0; px < gridSize; px++) {
      const idx = py * gridSize + px;

      // Smooth biome-driven modulation. Same function for open and closed
      // pixels so the floor varies naturally; the wall step rides on top.
      const m = (fbm(px * modFreq, py * modFreq, tileSeed ^ TERRAIN_SUB_SEED, 3) - 0.5) * 2;
      const floor = params.floorBaseline + floorBias + m * modAmp;

      // Only CLIFF kinds raise. Vegetation / water / other kinds stay
      // at floor height — collision is the openMask's job (phase 4B).
      const closed = openMask[idx] === 0;
      const isCliff = closed && kindOf[idx] === BOUNDARY_KIND_CLIFF;
      heightMap[idx] = isCliff ? floor + params.wallHeight : floor;
    }
  }

  return { heightMap };
}
