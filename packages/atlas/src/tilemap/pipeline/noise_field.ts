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
 */

import type { Transformer } from "@voxim/levelgen";
import { fbm } from "../../common/noise.ts";
import type { GenParams } from "../../genparams.ts";
import type { NoiseState, PipelineBase } from "./state.ts";

const NOISE_SUB_SEED = 0x30003001;

export const noiseField: Transformer<PipelineBase, NoiseState, GenParams["noise"]> =
  (state, seed, params) => {
    const { gridSize, worldCell: { biome } } = state;
    const N = gridSize * gridSize;

    const baseFreq = params.baseFrequency + biome.ruggedness * params.extraFrequencyPerRuggedness;
    const octaves  = params.octaves;

    const noiseField = new Float32Array(N);
    for (let py = 0; py < gridSize; py++) {
      for (let px = 0; px < gridSize; px++) {
        const v = fbm(px * baseFreq, py * baseFreq, seed ^ NOISE_SUB_SEED, octaves) * 2 - 1;
        noiseField[py * gridSize + px] = v;
      }
    }
    return { ...state, noiseField };
  };
