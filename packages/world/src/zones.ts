/**
 * Zone classification and per-tile grid storage — data-driven.
 *
 * Zone defs live in `packages/content/data/zones/*.json`. The generator
 * receives them pre-sorted by priority and evaluates each in order; a zone
 * matches when any of its `classifyRules` passes.
 */
import type { ZoneDef, ZoneClassifyRule } from "@voxim/content";

// ---- grid storage ----

export interface ZoneCell {
  /** Zone id (matches ZoneDef.id). */
  zoneId: string;
  /** Biome id (matches BiomeDef.id). */
  biomeId: string;
  /** Average world-unit height for cells in this zone. */
  avgHeight: number;
  /** Corruption level 0–100. */
  corruption: number;
}

export interface ZoneGridData {
  /** Number of zone cells per tile side. */
  gridSize: number;
  /** All zone cells, gridSize × gridSize, stored in row-major order. */
  cells: ZoneCell[];
}

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
  return grid.cells[zoneX + zoneY * grid.gridSize];
}

// ---- classification ----

export interface ZoneSample {
  biomeId: string;
  /** Normalized combined noise altitude [0, 1]. */
  normalizedAltitude: number;
  /** Ridge noise value at the zone centre [0, 1]. */
  tectonicValue: number;
  /** True if this zone overlaps the player spawn area. */
  isSpawnZone: boolean;
  /** Pseudo-random value in [0, 1). Used for `probability` rules. */
  rng: number;
}

function matchesRule(rule: ZoneClassifyRule, s: ZoneSample): boolean {
  if (rule.spawnZoneOnly && !s.isSpawnZone) return false;
  if (rule.biomes && !rule.biomes.includes(s.biomeId)) return false;
  if (rule.tectonicMin !== undefined && s.tectonicValue < rule.tectonicMin) return false;
  if (rule.altitudeMin !== undefined && s.normalizedAltitude < rule.altitudeMin) return false;
  if (rule.probability !== undefined && s.rng >= rule.probability) return false;
  return true;
}

/**
 * Pick the zone for a sample by iterating defs in priority order. A zone
 * matches when any of its classifyRules passes (empty rule {} always
 * matches, serving as a fallback). Throws if no zone matches.
 */
export function classifyZone(defs: readonly ZoneDef[], s: ZoneSample): ZoneDef {
  for (const def of defs) {
    for (const rule of def.classifyRules) {
      if (matchesRule(rule, s)) return def;
    }
  }
  throw new Error("classifyZone: no zone matched and no fallback is configured");
}
