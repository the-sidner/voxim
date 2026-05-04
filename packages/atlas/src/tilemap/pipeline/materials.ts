/**
 * Stage 5 — per-pixel material ids.
 *
 * Each sample-grid pixel gets a material id from atlas's small canonical
 * set (see MATERIAL_*). Selection is a deterministic rule over biome
 * params + a per-pixel detail noise:
 *
 *   altitude high      → stone
 *   hot + dry          → sand
 *   wet + noise > 0.6  → water puddle
 *   moisture moderate  → grass
 *   else               → dirt
 *
 * Walls and floors run the same rule. Walls get the SAME material as
 * the floor underneath them — the boundary KIND (tree, rock, etc.)
 * lives separately and is what makes a wall pixel render as a tree
 * vs. a boulder. Phase 6B emits just the underlying ground material.
 *
 * Tile-server (in a later phase) will translate atlas's small ID set
 * into its own content registry — atlas IDs are stable semantic markers,
 * not tile-server's runtime IDs.
 */

import { fbm } from "../../common/noise.ts";
import type { BiomeParams } from "../../worldmap/types.ts";
import type { GenParams } from "../../genparams.ts";

/**
 * Atlas's canonical material ids. Stable across versions; downstream
 * consumers translate to their own registry.
 *
 * 0 is reserved as "absent / not yet assigned" so a Uint16Array allocated
 * with default 0 reads as un-painted before the stage runs.
 */
export const MATERIAL_NONE  = 0;
export const MATERIAL_GRASS = 1;
export const MATERIAL_DIRT  = 2;
export const MATERIAL_STONE = 3;
export const MATERIAL_SAND  = 4;
export const MATERIAL_WATER = 5;

export interface MaterialsInput {
  biome: BiomeParams;
  tileSeed: number;
  gridSize: number;
  params: GenParams["materials"];
}

export interface MaterialsOutput {
  /** Length gridSize², row-major. Every entry is one of the MATERIAL_* ids. */
  materials: Uint16Array;
}

const DETAIL_SUB_SEED = 0x50005001;

export function runMaterials(input: MaterialsInput): MaterialsOutput {
  const { biome, tileSeed, gridSize, params } = input;
  const N = gridSize * gridSize;
  const materials = new Uint16Array(N);
  const f = params.detailFrequency;

  for (let py = 0; py < gridSize; py++) {
    for (let px = 0; px < gridSize; px++) {
      const detail = fbm(px * f, py * f, tileSeed ^ DETAIL_SUB_SEED, 2);
      materials[py * gridSize + px] = pickMaterial(biome, detail, params);
    }
  }

  return { materials };
}

function pickMaterial(
  b: BiomeParams,
  detail: number,
  p: GenParams["materials"],
): number {
  if (b.altitude > p.stoneAltitudeStrict) return MATERIAL_STONE;
  if (b.altitude > p.stoneAltitudeRugged && b.ruggedness > p.stoneRuggednessThreshold) return MATERIAL_STONE;
  if (b.temperature > p.sandTemperature && b.moisture < p.sandMoisture) return MATERIAL_SAND;
  if (b.moisture > p.waterMoisture && detail > p.waterDetail && b.altitude < p.waterAltitude) return MATERIAL_WATER;
  if (b.moisture > p.grassMoisture) return MATERIAL_GRASS;
  return MATERIAL_DIRT;
}
