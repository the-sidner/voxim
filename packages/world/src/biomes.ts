/**
 * Biome classification and material assignment.
 *
 * Biomes are derived from three continuous fields:
 *   - temperature  [0, 1]   (cold → hot)
 *   - moisture     [0, 1]   (dry → wet)
 *   - normalised altitude [0, 1]
 *
 * Material IDs must match content/data/materials.json.
 */

// ---------------------------------------------------------------------------
// Biome IDs
// ---------------------------------------------------------------------------

export const enum BiomeId {
  Water     = 0,
  Shore     = 1,
  Plains    = 2,
  Forest    = 3,
  Hills     = 4,
  Mountains = 5,
  Desert    = 6,
  Swamp     = 7,
  Tundra    = 8,
}

// ---------------------------------------------------------------------------
// Material ID constants
// ---------------------------------------------------------------------------

const MAT_GRASS      = 1;
const MAT_STONE      = 3;
const MAT_DIRT       = 4;
const MAT_SAND       = 5;
const MAT_WATER      = 8;
const MAT_CORRUPTED  = 9;
const MAT_SNOW       = 10;
const MAT_MUD        = 11;
const MAT_GRAVEL     = 12;
// const MAT_DARK_STONE = 13; // reserved for future use

// ---------------------------------------------------------------------------
// Biome classification
// ---------------------------------------------------------------------------

/**
 * Classify a point into a biome given its climate and altitude values.
 *
 * @param temperature      Normalised temperature [0, 1], 0 = polar cold, 1 = tropical hot.
 * @param moisture         Normalised moisture [0, 1], 0 = arid, 1 = saturated.
 * @param normalizedAltitude  Normalised combined noise altitude [0, 1].
 */
export function classifyBiome(
  temperature: number,
  moisture: number,
  normalizedAltitude: number,
): BiomeId {
  if (normalizedAltitude < 0.08) return BiomeId.Water;
  if (normalizedAltitude < 0.17) return BiomeId.Shore;
  if (normalizedAltitude > 0.72) return BiomeId.Mountains;
  if (temperature < 0.22)         return BiomeId.Tundra;
  if (moisture < 0.28 && temperature > 0.55) return BiomeId.Desert;
  if (moisture < 0.32)            return BiomeId.Hills;
  if (moisture > 0.70 && temperature > 0.35) return BiomeId.Swamp;
  if (moisture > 0.52 || (moisture > 0.40 && temperature < 0.60)) return BiomeId.Forest;
  return BiomeId.Plains;
}

// ---------------------------------------------------------------------------
// Material assignment
// ---------------------------------------------------------------------------

/**
 * Choose a surface material for a cell based on its biome and local conditions.
 *
 * @param biome       Classified biome.
 * @param normalizedH Normalised height within the world [0, 1] after curve application.
 * @param moisture    Moisture value at this cell.
 * @param detailNoise A blended detail noise value [0, 1] used for surface variation.
 * @param seed        World seed (unused directly, kept for future stochastic variants).
 * @param wx          World X — reserved for future positional variation.
 * @param wy          World Y — reserved for future positional variation.
 */
export function biomeMaterial(
  biome: BiomeId,
  normalizedH: number,
  moisture: number,
  detailNoise: number,
  _seed: number,
  _wx: number,
  _wy: number,
): number {
  switch (biome) {
    case BiomeId.Water:
      return MAT_WATER;

    case BiomeId.Shore:
      return MAT_SAND;

    case BiomeId.Desert:
      return normalizedH > 0.55 ? MAT_GRAVEL : MAT_SAND;

    case BiomeId.Tundra:
      if (normalizedH > 0.70) return MAT_SNOW;
      if (normalizedH > 0.50) return MAT_GRAVEL;
      return MAT_SNOW;

    case BiomeId.Plains:
      return normalizedH > 0.65 ? MAT_DIRT : MAT_GRASS;

    case BiomeId.Forest:
      if (normalizedH > 0.72) return MAT_STONE;
      if (detailNoise > 0.75) return MAT_DIRT;
      return MAT_GRASS;

    case BiomeId.Hills:
      if (normalizedH > 0.60) return MAT_STONE;
      if (normalizedH > 0.45) return MAT_GRAVEL;
      return MAT_GRASS;

    case BiomeId.Mountains:
      if (normalizedH > 0.80) return MAT_SNOW;
      if (normalizedH > 0.55) return MAT_STONE;
      return MAT_GRAVEL;

    case BiomeId.Swamp:
      if (moisture > 0.78 || normalizedH < 0.25) return MAT_MUD;
      if (detailNoise > 0.60) return MAT_CORRUPTED;
      return MAT_GRASS;

    default:
      return MAT_GRASS;
  }
}

// ---------------------------------------------------------------------------
// Biome-scale modifiers
// ---------------------------------------------------------------------------

/**
 * Height scale multiplier for a biome.
 * Applied to the combined base noise before the height curve.
 * Mountains > 1 to push relief upward; water < 1 to keep floors low.
 */
export function biomeHeightScale(biome: BiomeId): number {
  switch (biome) {
    case BiomeId.Water:     return 0.4;
    case BiomeId.Shore:     return 0.5;
    case BiomeId.Plains:    return 0.7;
    case BiomeId.Forest:    return 0.85;
    case BiomeId.Hills:     return 1.0;
    case BiomeId.Mountains: return 1.4;
    case BiomeId.Desert:    return 0.6;
    case BiomeId.Swamp:     return 0.65;
    case BiomeId.Tundra:    return 0.9;
    default:                return 1.0;
  }
}

/**
 * Detail roughness multiplier for a biome.
 * Scales how much the high-frequency detail noise layer contributes.
 * Mountains are roughest; water is nearly smooth.
 */
export function biomeRoughness(biome: BiomeId): number {
  switch (biome) {
    case BiomeId.Water:     return 0.1;
    case BiomeId.Shore:     return 0.3;
    case BiomeId.Plains:    return 0.6;
    case BiomeId.Forest:    return 0.85;
    case BiomeId.Hills:     return 1.0;
    case BiomeId.Mountains: return 1.2;
    case BiomeId.Desert:    return 0.4;
    case BiomeId.Swamp:     return 0.7;
    case BiomeId.Tundra:    return 0.8;
    default:                return 1.0;
  }
}
