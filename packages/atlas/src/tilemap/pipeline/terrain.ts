/**
 * Stage 7 — terrain heightmap.
 *
 * Two contributions per pixel:
 *   1. Wall baseline. STONE / FOREST / GRASS_MOUND pixels rise by
 *      WALL_HEIGHT from the floor — high enough that the runtime
 *      physics stepHeight can't auto-clear them, so they read as
 *      boundaries. WATER pixels (rivers/ponds) stay at floor height
 *      even though they're closed in `openMask`. Nearest-only
 *      sampling at consumption time prevents wall edges from
 *      averaging into climbable ramps.
 *   2. Smooth modulation. Low-amplitude fbm shaped by biome.ruggedness
 *      and biome.altitude — gives floors gentle variation without
 *      breaking the open/closed step.
 *
 * Pure function: same (openMask, kindOf, biome, tileSeed, gridSize) →
 * same Float32Array.
 */

import { fbm } from "../../common/noise.ts";
import type { BiomeParams } from "../../worldmap/types.ts";
import type { GenParams } from "../../genparams.ts";
import { BOUNDARY_KIND_WATER, BOUNDARY_KIND_OPEN } from "./boundary_kinds.ts";

export interface TerrainInput {
  openMask: Uint8Array;
  /**
   * Per-pixel boundary kind from the kinds stage (BOUNDARY_KIND_*).
   * Closed pixels other than WATER add the wallHeight step. WATER
   * pixels stay flat (rivers, ponds). Collision blocks them via the
   * openMask path in tile-server's physics.
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
export const WALL_HEIGHT = 2.0;

/**
 * How far below floor the WATER channel cuts (T-159).  Rivers carve a
 * shallow trench so the water surface (drawn by the client at
 * `floor` height as a translucent overlay) sits visibly above the bed.
 *
 * Client mirrors this value at `client/render/water_mesh.ts:RIVER_DEPTH` —
 * keep them in sync when tuning.
 */
export const RIVER_DEPTH = 0.5;

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

      // All wall kinds (STONE / FOREST / GRASS_MOUND) raise.  WATER cuts a
      // shallow trench (rivers run below the surrounding floor — T-159); the
      // client renders a translucent water surface back at `floor` height.
      // OPEN cells stay at floor.  Collision still blocks closed pixels via openMask.
      const k = kindOf[idx];
      const isClosed = openMask[idx] === 0;
      const isWater  = isClosed && k === BOUNDARY_KIND_WATER;
      const isWall   = isClosed && k !== BOUNDARY_KIND_WATER && k !== BOUNDARY_KIND_OPEN;
      heightMap[idx] = isWall  ? floor + params.wallHeight
                     : isWater ? floor - RIVER_DEPTH
                               : floor;
    }
  }

  return { heightMap };
}
