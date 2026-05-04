/**
 * Stage 1 — noise field → openMask.
 *
 * Samples 2D fbm at sample-grid resolution, thresholds it into a binary
 * open/closed mask. Two scalars from the worldmap biome bundle drive
 * the look:
 *
 *   ruggedness ↑  → frequency ↑ (more, smaller features per tile)
 *                   threshold ↑ (more closed pixels — denser maze)
 *   altitude   ↑  → (reserved for height modulation in a later stage)
 *
 * Pure function: same (biome, tileSeed, gridSize) always yields the
 * same Float32Array + Uint8Array.
 */

import { fbm } from "../../common/noise.ts";
import type { BiomeParams } from "../../worldmap/types.ts";
import type { GenParams } from "../../genparams.ts";

export interface NoiseFieldInput {
  biome: BiomeParams;
  tileSeed: number;
  gridSize: number;
  params: GenParams["noise"];
}

export interface NoiseFieldOutput {
  /** Raw fbm values [-1ish, 1ish], length gridSize². */
  noiseField: Float32Array;
  /** 1 = open, 0 = closed, length gridSize². */
  openMask: Uint8Array;
  /**
   * The biome-resolved threshold used to derive openMask: a pixel is
   * open iff its noise value is < threshold. Downstream stages use this
   * to express carve cost relative to "how deep into the wall" a closed
   * pixel sits.
   */
  threshold: number;
}

const NOISE_SUB_SEED = 0x30003001;

export function runNoiseField(input: NoiseFieldInput): NoiseFieldOutput {
  const { biome, tileSeed, gridSize, params } = input;
  const N = gridSize * gridSize;

  const baseFreq  = params.baseFrequency + biome.ruggedness * params.extraFrequencyPerRuggedness;
  const threshold = params.baseThreshold + biome.ruggedness * params.extraThresholdPerRuggedness;
  const octaves   = params.octaves;

  const noiseField = new Float32Array(N);
  const openMask   = new Uint8Array(N);

  // fbm returns [0, 1]; recentre to [-1, 1] so threshold sweeps through 0
  // intuitively (negative = open, positive = closed at threshold = 0).
  for (let py = 0; py < gridSize; py++) {
    for (let px = 0; px < gridSize; px++) {
      const v = fbm(px * baseFreq, py * baseFreq, tileSeed ^ NOISE_SUB_SEED, octaves) * 2 - 1;
      const idx = py * gridSize + px;
      noiseField[idx] = v;
      openMask[idx]   = v < threshold ? 1 : 0;
    }
  }

  return { noiseField, openMask, threshold };
}
