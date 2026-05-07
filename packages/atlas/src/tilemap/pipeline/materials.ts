/**
 * Stage — per-pixel material ids.
 *
 * Three classes of pixel and three different decisions:
 *
 *   1. Closed pixel  → pickClosedMaterial(kindOf): STONE / FOREST / WATER
 *      / GRASS_MOUND walls each paint their own colour on top of the
 *      raised step.
 *
 *   2. Open pixel that is a CORRIDOR (chamberOf == ROOM_ID_NONE & open)
 *      → a worn-trail material. We pick by surrounding biome so paths
 *      through forest read as packed dirt, paths through stony highlands
 *      as gravel, paths through open meadows as gravel-on-grass.
 *
 *   3. Open pixel inside a chamber/room → biome rule + a high-frequency
 *      "spread" noise that perturbs the choice locally. Uniform grass
 *      breaks into patches of dirt and gravel; uniform stone gets moss
 *      veins; uniform dirt gets mud and gravel speckles.
 *
 * Atlas IDs are stable semantic markers; tile-server translates to its
 * own registry. Never reuse a retired id.
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
export const MATERIAL_NONE   = 0;
export const MATERIAL_GRASS  = 1;
export const MATERIAL_DIRT   = 2;
export const MATERIAL_STONE  = 3;
export const MATERIAL_SAND   = 4;
export const MATERIAL_WATER  = 5;
export const MATERIAL_GRAVEL = 6;
export const MATERIAL_MUD    = 7;
export const MATERIAL_MOSS   = 8;
export const MATERIAL_PATH   = 9;
export const MATERIAL_SNOW   = 10;

/** Sentinel for chamberOf — pixels that are open but not inside a chamber
 *  (i.e. corridor pixels carved by the network/portal stages). Mirrors
 *  `ROOM_ID_NONE` from rooms.ts; duplicated here to keep this file self-
 *  contained. */
const ROOM_ID_NONE = 0xFFFF;

export interface MaterialsInput {
  biome: BiomeParams;
  tileSeed: number;
  gridSize: number;
  params: GenParams["materials"];
  /** From upstream stages — used to pick a darker fallback on closed pixels. */
  openMask: Uint8Array;
  kindOf:   Uint16Array;
  /** Pre-network chamber id per pixel; ROOM_ID_NONE on corridors and closed pixels. */
  chamberOf: Uint16Array;
}

export interface MaterialsOutput {
  /** Length gridSize², row-major. Every entry is one of the MATERIAL_* ids. */
  materials: Uint16Array;
}

const DETAIL_SUB_SEED  = 0x50005001;
const SPREAD_SUB_SEED  = 0xC0FFEE17;
const SPREAD_FREQUENCY = 0.18;  // higher freq than detailFrequency → small patches

export function runMaterials(input: MaterialsInput): MaterialsOutput {
  const { biome, tileSeed, gridSize, params, openMask, kindOf, chamberOf } = input;
  const N = gridSize * gridSize;
  const materials = new Uint16Array(N);
  const fDetail = params.detailFrequency;
  const fSpread = SPREAD_FREQUENCY;

  for (let py = 0; py < gridSize; py++) {
    for (let px = 0; px < gridSize; px++) {
      const idx = py * gridSize + px;

      if (openMask[idx] === 0) {
        // Closed pixel: kind-driven fallback so the wall reads on flat
        // ground without needing a height step.
        materials[idx] = pickClosedMaterial(kindOf[idx]);
        continue;
      }

      // Open pixel.
      const isCorridor = chamberOf[idx] === ROOM_ID_NONE;
      const detail = fbm(px * fDetail, py * fDetail, tileSeed ^ DETAIL_SUB_SEED, 2);

      if (isCorridor) {
        // Carved trail: pick by surrounding biome so the path's material
        // reads against its setting (dirt through forest, gravel through
        // open / stony land, snow through cold).
        materials[idx] = pickPathMaterial(biome, params);
        continue;
      }

      // Chamber/room interior — biome decision + high-frequency spread
      // noise so uniform colour breaks into believable patches.
      const baseMat = pickMaterial(biome, detail, params);
      const spread  = fbm(px * fSpread, py * fSpread, tileSeed ^ SPREAD_SUB_SEED, 2);
      materials[idx] = perturbWithSpread(baseMat, biome, spread);
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

/**
 * Material for carved corridor pixels. Paths are picked by the prevailing
 * biome — a trail through forest is packed dirt; through stony highlands
 * it's gravel; through cold land it's trodden snow. The carve geometry
 * stays the same; only the visual changes.
 */
function pickPathMaterial(b: BiomeParams, p: GenParams["materials"]): number {
  if (b.temperature < 0.25)                 return MATERIAL_SNOW;    // cold trail
  if (b.altitude > p.stoneAltitudeRugged)   return MATERIAL_GRAVEL;  // mountain track
  if (b.moisture > p.grassMoisture)         return MATERIAL_PATH;    // worn-grass path
  return MATERIAL_GRAVEL;                                            // default trail
}

/**
 * Replace the base material with a related variant when a high-frequency
 * spread noise crosses a threshold. Keeps the biome-driven base most of
 * the time but breaks up uniform colour with believable patches.
 */
function perturbWithSpread(base: number, b: BiomeParams, spread: number): number {
  // Threshold >0 is a small chance; >0.4 a rare chance. Spread is in [-1, 1].
  switch (base) {
    case MATERIAL_GRASS:
      if (spread > 0.55)  return MATERIAL_DIRT;    // bare patches in meadows
      if (spread > 0.40)  return MATERIAL_GRAVEL;  // tiny stone patches
      if (spread < -0.55 && b.moisture > 0.5) return MATERIAL_MOSS;
      return MATERIAL_GRASS;
    case MATERIAL_DIRT:
      if (spread > 0.55)  return MATERIAL_GRAVEL;  // gravel speckles
      if (spread < -0.55 && b.moisture > 0.5) return MATERIAL_MUD;
      return MATERIAL_DIRT;
    case MATERIAL_STONE:
      if (spread > 0.55)  return MATERIAL_GRAVEL;  // weathered scree
      if (spread < -0.55) return MATERIAL_MOSS;    // moss veins
      return MATERIAL_STONE;
    case MATERIAL_SAND:
      if (spread > 0.65)  return MATERIAL_GRAVEL;  // pebble strips
      return MATERIAL_SAND;
    default:
      return base;
  }
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
