/**
 * Zone type definitions, spawn profiles, grid storage and classification logic.
 *
 * Zones are a coarser-resolution layer on top of the heightmap that determine
 * danger level, corruption, NPC spawn weights and resource node weights for
 * an area of the tile.
 */

import { BiomeId } from "./biomes.ts";

// ---------------------------------------------------------------------------
// Zone type enum
// ---------------------------------------------------------------------------

export const enum ZoneType {
  SafeZone   = 0,
  Plains     = 1,
  Forest     = 2,
  Hills      = 3,
  Mountains  = 4,
  Swamp      = 5,
  Tundra     = 6,
  Desert     = 7,
  Ruins      = 8,
  Shore      = 9,
  Water      = 10,
}

// ---------------------------------------------------------------------------
// Spawn profiles
// ---------------------------------------------------------------------------

export interface ZoneSpawnProfile {
  /** Danger rating from 0 (completely safe) to 10 (lethal to new players). */
  dangerLevel: number;
  /** Baseline corruption percentage (0–100) for cells in this zone. */
  corruptionBaseline: number;
  /** Spawn weight table for NPC types (key = npcType string, value ≥ 0). */
  npcWeights: Record<string, number>;
  /** Spawn weight table for entity templates (key = EntityTemplate.id, value ≥ 0). */
  entityWeights: Record<string, number>;
  /** Spawn weight table for decorative prop model IDs (key = modelTemplateId, value ≥ 0). */
  propWeights: Record<string, number>;
}

export const ZONE_PROFILES: Record<ZoneType, ZoneSpawnProfile> = {
  [ZoneType.SafeZone]: {
    dangerLevel: 0,
    corruptionBaseline: 0,
    npcWeights: { villager: 10, merchant: 5 },
    entityWeights: { flower_patch: 3 },
    propWeights: { model_building_well: 2, model_building_cottage: 3 },
  },
  [ZoneType.Plains]: {
    dangerLevel: 1,
    corruptionBaseline: 5,
    npcWeights: { villager: 6, bandit: 2 },
    entityWeights: { tree: 4, stone_deposit: 2, bush: 5, flower_patch: 4, rock_small: 2 },
    propWeights: { model_dead_tree: 1 },
  },
  [ZoneType.Forest]: {
    dangerLevel: 3,
    corruptionBaseline: 10,
    npcWeights: { wolf: 4, bandit: 1 },
    entityWeights: { tree: 10, stone_deposit: 1, iron_ore_vein: 1, bush: 4, pine_tree: 6, rock_small: 1 },
    propWeights: { model_dead_tree: 2 },
  },
  [ZoneType.Hills]: {
    dangerLevel: 4,
    corruptionBaseline: 15,
    npcWeights: { bandit: 6, wolf: 3 },
    entityWeights: { stone_deposit: 8, iron_ore_vein: 3, tree: 2, rock_small: 4, rock_large: 3, bush: 2 },
    propWeights: { model_dead_tree: 2 },
  },
  [ZoneType.Mountains]: {
    dangerLevel: 7,
    corruptionBaseline: 25,
    npcWeights: { bandit: 4 },
    entityWeights: { stone_deposit: 10, iron_ore_vein: 8, rock_large: 6, pine_tree: 2 },
    propWeights: { model_building_ruin_wall: 1 },
  },
  [ZoneType.Swamp]: {
    dangerLevel: 5,
    corruptionBaseline: 60,
    npcWeights: { wolf: 5 },
    entityWeights: { tree: 3, bush: 4 },
    propWeights: { model_dead_tree: 6, model_building_ruin_wall: 2 },
  },
  [ZoneType.Tundra]: {
    dangerLevel: 6,
    corruptionBaseline: 20,
    npcWeights: { wolf: 6 },
    entityWeights: { stone_deposit: 5, iron_ore_vein: 2, pine_tree: 4, rock_small: 3 },
    propWeights: { model_dead_tree: 3 },
  },
  [ZoneType.Desert]: {
    dangerLevel: 4,
    corruptionBaseline: 15,
    npcWeights: { bandit: 8, merchant: 2 },
    entityWeights: { stone_deposit: 4, rock_large: 2 },
    propWeights: { model_building_ruin_wall: 3, model_building_ruin_tower: 2 },
  },
  [ZoneType.Ruins]: {
    dangerLevel: 8,
    corruptionBaseline: 85,
    npcWeights: { bandit: 10 },
    entityWeights: { iron_ore_vein: 5 },
    propWeights: { model_building_ruin_wall: 8, model_building_ruin_tower: 5, model_dead_tree: 3 },
  },
  [ZoneType.Shore]: {
    dangerLevel: 1,
    corruptionBaseline: 0,
    npcWeights: { villager: 3, merchant: 4 },
    entityWeights: { tree: 2, flower_patch: 3, bush: 2 },
    propWeights: {},
  },
  [ZoneType.Water]: {
    dangerLevel: 2,
    corruptionBaseline: 0,
    npcWeights: {},
    entityWeights: {},
    propWeights: {},
  },
};

// ---------------------------------------------------------------------------
// Zone grid structures
// ---------------------------------------------------------------------------

export interface ZoneCell {
  /** Zone type for this cell. */
  zoneType: ZoneType;
  /** BiomeId value for this cell (see biomes.ts). */
  biomeId: number;
  /** Average world-unit height for cells in this zone. */
  avgHeight: number;
  /** Corruption level 0–100. */
  corruption: number;
}

export interface ZoneGridData {
  /** Number of zone cells per tile side (e.g. 32 for a 32×32 grid). */
  gridSize: number;
  /** All zone cells, gridSize × gridSize, stored in row-major order. */
  cells: ZoneCell[];
}

// ---------------------------------------------------------------------------
// Zone grid access
// ---------------------------------------------------------------------------

/**
 * Return the ZoneCell at a given world position.
 *
 * World coordinates are clamped to [0, 511] before mapping.
 *
 * @param grid   The zone grid for this tile.
 * @param worldX World X position (0–511).
 * @param worldY World Y position (0–511).
 */
export function getZoneAt(
  grid: ZoneGridData,
  worldX: number,
  worldY: number,
): ZoneCell {
  const clampedX = Math.max(0, Math.min(511, worldX));
  const clampedY = Math.max(0, Math.min(511, worldY));

  const cellsPerUnit = 512 / grid.gridSize;
  const zoneX = Math.floor(clampedX / cellsPerUnit);
  const zoneY = Math.floor(clampedY / cellsPerUnit);

  const idx = zoneX + zoneY * grid.gridSize;
  return grid.cells[idx];
}

// ---------------------------------------------------------------------------
// Zone classification
// ---------------------------------------------------------------------------

/**
 * Classify a zone cell given terrain and climate values.
 *
 * @param biomeId           BiomeId value from classifyBiome.
 * @param normalizedAltitude Normalised combined noise altitude [0, 1].
 * @param moisture          Moisture at the zone centre [0, 1].
 * @param tectonicValue     Ridge noise value at the zone centre [0, 1].
 * @param isSpawnZone       True if this zone overlaps the player spawn area.
 * @param ruinChance        Probability (0–1) of an eligible zone becoming Ruins.
 * @param ruinMinAltitude   Minimum normalised altitude for ruin eligibility.
 * @param rng               A [0, 1) pseudo-random value for probabilistic assignment.
 */
export function classifyZone(
  biomeId: number,
  normalizedAltitude: number,
  _moisture: number,
  tectonicValue: number,
  isSpawnZone: boolean,
  ruinChance: number,
  ruinMinAltitude: number,
  rng: number,
): ZoneType {
  if (isSpawnZone)              return ZoneType.SafeZone;
  if (biomeId === BiomeId.Water)     return ZoneType.Water;
  if (biomeId === BiomeId.Shore)     return ZoneType.Shore;
  if (biomeId === BiomeId.Mountains) return ZoneType.Mountains;
  if (biomeId === BiomeId.Swamp)     return ZoneType.Swamp;
  if (biomeId === BiomeId.Tundra)    return ZoneType.Tundra;
  if (biomeId === BiomeId.Desert)    return ZoneType.Desert;

  if (biomeId === BiomeId.Hills || tectonicValue > 0.6) {
    if (rng < ruinChance && normalizedAltitude > ruinMinAltitude) {
      return ZoneType.Ruins;
    }
    return ZoneType.Hills;
  }

  if (biomeId === BiomeId.Forest)    return ZoneType.Forest;

  return ZoneType.Plains;
}
