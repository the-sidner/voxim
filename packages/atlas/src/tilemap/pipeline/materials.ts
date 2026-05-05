/**
 * Stage — per-pixel material ids.
 *
 * Open pixels: pick from biome params + detail noise (grass / dirt /
 * stone / sand / water).
 *
 * Closed pixels: pick by wall kind so each of the three wall types
 * paints a distinct material on top of its raised step:
 *   STONE        → STONE   (grey rock)
 *   FOREST       → DIRT    (forest understory, brown; trees on top)
 *   GRASS_MOUND  → GRASS   (green berm)
 *   WATER        → WATER   (rivers/ponds, blue; flat)
 *   default      → DIRT
 *
 * Atlas IDs are stable semantic markers; tile-server translates to its
 * own registry.
 */

import { fbm } from "../../common/noise.ts";
import type { BiomeParams } from "../../worldmap/types.ts";
import type { GenParams } from "../../genparams.ts";
import {
  BOUNDARY_KIND_STONE,
  BOUNDARY_KIND_FOREST,
  BOUNDARY_KIND_GRASS_MOUND,
  BOUNDARY_KIND_WATER,
} from "./boundary_kinds.ts";

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
  /** From upstream stages — used to pick a darker fallback on closed pixels. */
  openMask: Uint8Array;
  kindOf:   Uint16Array;
}

export interface MaterialsOutput {
  /** Length gridSize², row-major. Every entry is one of the MATERIAL_* ids. */
  materials: Uint16Array;
}

const DETAIL_SUB_SEED = 0x50005001;

export function runMaterials(input: MaterialsInput): MaterialsOutput {
  const { biome, tileSeed, gridSize, params, openMask, kindOf } = input;
  const N = gridSize * gridSize;
  const materials = new Uint16Array(N);
  const f = params.detailFrequency;

  for (let py = 0; py < gridSize; py++) {
    for (let px = 0; px < gridSize; px++) {
      const idx = py * gridSize + px;
      if (openMask[idx] === 0) {
        // Closed pixel — visual contrast comes from a darker, kind-driven
        // fallback so the wall reads on flat ground (no height step needed).
        materials[idx] = pickClosedMaterial(kindOf[idx]);
      } else {
        const detail = fbm(px * f, py * f, tileSeed ^ DETAIL_SUB_SEED, 2);
        materials[idx] = pickMaterial(biome, detail, params);
      }
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

function pickClosedMaterial(kind: number): number {
  switch (kind) {
    case BOUNDARY_KIND_STONE:       return MATERIAL_STONE;  // bare rock
    case BOUNDARY_KIND_FOREST:      return MATERIAL_DIRT;   // forest floor
    case BOUNDARY_KIND_GRASS_MOUND: return MATERIAL_GRASS;  // green berm
    case BOUNDARY_KIND_WATER:       return MATERIAL_WATER;  // rivers/ponds
    default:                        return MATERIAL_DIRT;
  }
}
