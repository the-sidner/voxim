/**
 * Biome classification and material assignment — data-driven.
 *
 * Biome defs live in `packages/content/data/biomes/*.json`. The generator
 * receives them pre-sorted by priority; the first biome whose
 * `classifyRules` match the sample wins (or the fallback biome when its
 * classifyRules are empty).
 */
import type { BiomeDef, BiomeClassifyRule, BiomeMaterialRule } from "@voxim/content";

// ---- sample types ----

export interface BiomeSample {
  temperature: number;
  moisture: number;
  /** Normalized combined noise altitude [0, 1]. */
  normalizedAltitude: number;
}

export interface BiomeMaterialSample {
  normalizedHeight: number;
  moisture: number;
  detailNoise: number;
}

// ---- classification ----

function matchesRange(value: number, range?: { min?: number; max?: number }): boolean {
  if (!range) return true;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

function matchesClassifyRule(rule: BiomeClassifyRule, s: BiomeSample): boolean {
  return matchesRange(s.normalizedAltitude, rule.altitude)
      && matchesRange(s.temperature, rule.temperature)
      && matchesRange(s.moisture, rule.moisture);
}

/**
 * Pick the biome for a sample by iterating defs in priority order.
 *   - Biomes with non-empty `classifyRules`: match when ANY rule matches.
 *   - Biomes with empty `classifyRules`: act as fallbacks — match unconditionally.
 * The first matching biome wins. Throws if no biome matches (misconfiguration).
 */
export function classifyBiome(defs: readonly BiomeDef[], s: BiomeSample): BiomeDef {
  for (const def of defs) {
    if (def.classifyRules.length === 0) return def;
    for (const rule of def.classifyRules) {
      if (matchesClassifyRule(rule, s)) return def;
    }
  }
  throw new Error("classifyBiome: no biome matched and no fallback is configured");
}

// ---- material assignment ----

function matchesMaterialRule(rule: BiomeMaterialRule, s: BiomeMaterialSample): boolean {
  return matchesRange(s.normalizedHeight, rule.normalizedHeight)
      && matchesRange(s.moisture, rule.moisture)
      && matchesRange(s.detailNoise, rule.detailNoise);
}

/**
 * Return the material name for a cell by iterating the biome's material
 * rules in order — first match wins. The last rule should carry no range
 * conditions so it always matches as a fallback.
 */
export function biomeMaterialName(def: BiomeDef, s: BiomeMaterialSample): string {
  for (const rule of def.materialRules) {
    if (matchesMaterialRule(rule, s)) return rule.materialName;
  }
  throw new Error(`biome "${def.id}" has no fallback material rule`);
}
