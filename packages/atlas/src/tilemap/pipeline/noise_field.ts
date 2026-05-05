/**
 * Stage 1 — sample the noise field used by downstream stages.
 *
 * Produces a per-pixel scalar field (fbm). The chambers stage uses it as
 * a *cost surface* to grow organic chamber shapes (low-noise pixels are
 * more likely to be carved into a chamber). Other downstream stages
 * sample their own fbm channels with different sub-seeds.
 *
 * The noise field is purely cost; there is no global threshold gating
 * "open vs closed" anymore — chambers carve into a default-closed mask.
 *
 *   ruggedness ↑  → frequency ↑ (more, smaller features per tile)
 *
 * Pure function: same (biome, tileSeed, gridSize) always yields the
 * same Float32Array.
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
  /** Raw fbm values (~ -1..1), length gridSize². */
  noiseField: Float32Array;
}

const NOISE_SUB_SEED = 0x30003001;

export function runNoiseField(input: NoiseFieldInput): NoiseFieldOutput {
  const { biome, tileSeed, gridSize, params } = input;
  const N = gridSize * gridSize;

  const baseFreq = params.baseFrequency + biome.ruggedness * params.extraFrequencyPerRuggedness;
  const octaves  = params.octaves;

  const noiseField = new Float32Array(N);
  for (let py = 0; py < gridSize; py++) {
    for (let px = 0; px < gridSize; px++) {
      const v = fbm(px * baseFreq, py * baseFreq, tileSeed ^ NOISE_SUB_SEED, octaves) * 2 - 1;
      noiseField[py * gridSize + px] = v;
    }
  }
  return { noiseField };
}
