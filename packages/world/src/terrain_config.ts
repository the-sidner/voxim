/**
 * Terrain generation configuration types and default values.
 *
 * Every knob used by the multi-layer terrain generator is centralised here so
 * the server can override them at runtime (e.g. from terrain_config.json)
 * without recompiling.
 */

// ---------------------------------------------------------------------------
// Sub-config interfaces
// ---------------------------------------------------------------------------

export interface DomainWarpConfig {
  /** Whether coordinate warping is applied before the main noise passes. */
  enabled: boolean;
  /** World units of maximum displacement applied by the warp field. */
  amplitude: number;
  /** Base noise frequency for the warp field (lower → broader swirls). */
  frequency: number;
  /** FBM octave count for the warp noise (more → finer detail in warping). */
  octaves: number;
}

export interface NoiseLayerConfig {
  /** Base frequency: how many noise cycles per world unit. */
  frequency: number;
  /** Number of FBM octaves layered together. */
  octaves: number;
  /** Frequency multiplier per octave (typical: 1.9–2.1). */
  lacunarity: number;
  /** Amplitude multiplier per octave (typical: 0.45–0.55). */
  gain: number;
}

export interface TectonicConfig extends NoiseLayerConfig {
  /** Fraction of the height range that tectonic ridges contribute (0–1). */
  weight: number;
  /** Ridge offset for ridgedFbm; 1.0 gives standard mountain ridges. */
  ridgeOffset: number;
  /**
   * Continental noise value below which tectonic ridges are suppressed.
   * Keeps ridges from appearing in low-lying ocean areas.
   */
  continentThreshold: number;
  /** Width of the blend band around continentThreshold (in normalised noise). */
  continentBlend: number;
}

export interface DetailConfig extends NoiseLayerConfig {
  /**
   * Maximum fraction of the full height range used for surface detail.
   * Biome roughness further scales this per cell.
   */
  weight: number;
  /** 0 = pure FBM detail, 1 = pure billow detail, values in between blend both. */
  billowMix: number;
}

export interface MoistureConfig extends NoiseLayerConfig {
  /** Constant added to moisture before clamping. Shifts the global biome wetness. */
  bias: number;
}

export interface TemperatureConfig extends NoiseLayerConfig {
  /** Constant added to raw temperature before altitude correction. */
  bias: number;
  /**
   * How much temperature drops per unit of normalised continental altitude.
   * Higher values make mountain tops colder (and therefore snowier).
   */
  altitudeFalloff: number;
}

export interface HeightCurveConfig {
  /** Normalised noise value treated as sea level (0–1). */
  seaLevel: number;
  /** Normalised band around seaLevel that maps to shore/beach height range. */
  shoreWidth: number;
  /**
   * Power applied to land above sea level.
   * > 1 flattens lowlands and pushes relief toward highlands.
   * < 1 produces more varied, rougher terrain everywhere.
   */
  landExponent: number;
  /**
   * Additional power applied to values above 0.7 to sharpen mountain peaks.
   * Higher values produce narrower, taller spires.
   */
  mountainExponent: number;
  /** World-unit height of the lowest terrain (water floor). */
  heightMin: number;
  /** World-unit height of the tallest mountain peak. */
  heightMax: number;
}

export interface SpawnZoneConfig {
  /** Tile-space X coordinate of the spawn zone centre. */
  centerX: number;
  /** Tile-space Y coordinate of the spawn zone centre. */
  centerY: number;
  /** World units: terrain is fully flat (targetNoise height) inside this radius. */
  flatRadius: number;
  /** World units: linear blend from flat height to full noise over this distance. */
  fadeRadius: number;
  /**
   * Normalised noise value used to compute the flat spawn height.
   * Pick something in the grass biome range (0.40–0.55).
   */
  targetNoise: number;
}

export interface ErosionConfig {
  /** Master switch — when false no post-generation erosion is performed. */
  enabled: boolean;
  /**
   * Number of thermal erosion passes over the full heightmap.
   * 0 disables thermal erosion even if enabled is true.
   */
  thermalPasses: number;
  /**
   * Maximum stable height difference between adjacent cells (in world units).
   * Cells with a steeper slope shed material downhill each pass.
   */
  thermalAngle: number;
  /**
   * Moisture-driven smoothing strength (0–1).
   * Higher values soften wet biomes (swamps, coasts) more aggressively.
   * Currently reserved for future hydraulic erosion pass.
   */
  hydraulicStrength: number;
}

export interface ZoneConfig {
  /**
   * Number of zone grid cells per tile side.
   * E.g. 32 → 32×32 = 1 024 zones per 512-unit tile, each covering 16 units.
   */
  gridSize: number;
  /** Probability (0–1) that an eligible hills/mountains zone becomes Ruins. */
  ruinChance: number;
  /** Normalised altitude threshold: only zones above this can become Ruins. */
  ruinMinAltitude: number;
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

export interface TerrainConfig {
  domainWarp: DomainWarpConfig;
  continent: NoiseLayerConfig;
  tectonic: TectonicConfig;
  detail: DetailConfig;
  moisture: MoistureConfig;
  temperature: TemperatureConfig;
  heightCurve: HeightCurveConfig;
  spawnZone: SpawnZoneConfig;
  erosion: ErosionConfig;
  zone: ZoneConfig;
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

export const DEFAULT_TERRAIN_CONFIG: TerrainConfig = {
  domainWarp: {
    enabled: true,
    amplitude: 48,
    frequency: 0.0038,
    octaves: 3,
  },
  continent: {
    frequency: 0.0022,
    octaves: 7,
    lacunarity: 2.05,
    gain: 0.50,
  },
  tectonic: {
    frequency: 0.0058,
    octaves: 6,
    lacunarity: 1.95,
    gain: 0.46,
    weight: 0.38,
    ridgeOffset: 1.0,
    continentThreshold: 0.42,
    continentBlend: 0.15,
  },
  detail: {
    frequency: 0.028,
    octaves: 5,
    lacunarity: 2.2,
    gain: 0.52,
    weight: 0.11,
    billowMix: 0.35,
  },
  moisture: {
    frequency: 0.0036,
    octaves: 4,
    lacunarity: 2.1,
    gain: 0.5,
    bias: 0.0,
  },
  temperature: {
    frequency: 0.0042,
    octaves: 3,
    lacunarity: 2.0,
    gain: 0.5,
    bias: 0.0,
    altitudeFalloff: 0.9,
  },
  heightCurve: {
    seaLevel: 0.40,
    shoreWidth: 0.045,
    landExponent: 1.35,
    mountainExponent: 2.2,
    heightMin: 1.5,
    heightMax: 13.0,
  },
  spawnZone: {
    centerX: 256,
    centerY: 256,
    flatRadius: 28,
    fadeRadius: 72,
    targetNoise: 0.47,
  },
  erosion: {
    enabled: true,
    thermalPasses: 12,
    thermalAngle: 1.2,
    hydraulicStrength: 0.15,
  },
  zone: {
    gridSize: 32,
    ruinChance: 0.06,
    ruinMinAltitude: 0.38,
  },
};
