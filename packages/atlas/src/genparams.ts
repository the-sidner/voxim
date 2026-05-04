/**
 * Worldgen tuning knobs.
 *
 * Every "magic number" in the generator pipeline lives here. Each stage
 * takes its slice (e.g. NoiseFieldInput.params: GenParams["noise"]) and
 * uses no module-level constants of its own — so a designer can tweak
 * a value, rebake, and see exactly what changed.
 *
 * The params are persisted on the `worlds` row alongside seed/dims, so
 * each baked world preserves its tuning (re-bakes are reproducible, and
 * comparing worlds means comparing their params).
 *
 * Sub-seed constants used by the noise channels (SEED_TEMP, SEED_RIVER_PICK,
 * etc.) are NOT in here — they're wire/format details that decorrelate noise
 * channels and shouldn't be tweaked. They stay as module consts in their
 * respective files.
 */

export interface GenParams {
  /** Cell-grid biome field — temperature, moisture, altitude, ruggedness. */
  biome: {
    /** Cell-grid frequency. Lower = larger biome regions. ~6 cells / blob @ 1/6. */
    frequency: number;
    /** fbm octaves for biome fields. More = more detail at boundaries. */
    octaves: number;
  };

  /** River planning at world scale + width at tile scale. */
  river: {
    /** Cells with biome.altitude above this can spawn a river source. */
    sourceAltitude: number;
    /** Chebyshev distance between sources (poor-man's Poisson disk). */
    minSeparation: number;
    /** Pixel radius of stamped river width (so river is ~2*r+1 px wide). */
    widthPixels: number;
  };

  /** Tile-scale noise field that emerges into rooms. */
  noise: {
    /** noise base freq = baseFrequency + ruggedness * extraFrequencyPerRuggedness. */
    baseFrequency: number;
    extraFrequencyPerRuggedness: number;
    /** open/closed threshold = baseThreshold + ruggedness * extraThresholdPerRuggedness. */
    baseThreshold: number;
    extraThresholdPerRuggedness: number;
    /** fbm octaves at tile scale. */
    octaves: number;
  };

  /** Heightmap stage. */
  terrain: {
    /**
     * Vertical step at every CLIFF wall pixel. Must exceed runtime
     * physics stepHeight (currently 0.75u) so cliffs aren't traversable.
     */
    wallHeight: number;
    /** Baseline ground height inside open regions, before biome bias. */
    floorBaseline: number;
    /** Floor modulation amplitude before biome.ruggedness scaling. */
    floorModAmplitude: number;
    /** Floor modulation noise frequency (cycles per pixel). */
    floorModFrequency: number;
  };

  /** Per-pixel material rule selectors. */
  materials: {
    /** Per-pixel detail noise frequency. */
    detailFrequency: number;
    /** altitude > X → STONE. */
    stoneAltitudeStrict: number;
    /** altitude > X AND ruggedness > Y → STONE. */
    stoneAltitudeRugged: number;
    stoneRuggednessThreshold: number;
    /** temperature > X AND moisture < Y → SAND. */
    sandTemperature: number;
    sandMoisture: number;
    /** moisture > A AND altitude < B AND detail > C → WATER puddle. */
    waterMoisture: number;
    waterAltitude: number;
    waterDetail: number;
    /** moisture > X → GRASS, else DIRT. */
    grassMoisture: number;
  };

  /** Per-pixel boundary kind (CLIFF / VEGETATION / WATER) selectors. */
  kinds: {
    /** Per-pixel detail noise frequency. */
    detailFrequency: number;
    /** Closed pixel: altitude > X → CLIFF. */
    cliffAltitudeStrict: number;
    /** altitude > X AND ruggedness > Y → CLIFF. */
    cliffAltitudeRugged: number;
    cliffRuggednessThreshold: number;
    /** moisture > A AND altitude < B AND detail > C → WATER. */
    waterMoisture: number;
    waterAltitude: number;
    waterDetail: number;
    /** moisture > X → VEGETATION (else falls back to CLIFF). */
    vegetationMoisture: number;
  };
}

/**
 * Defaults match the values that have been hand-tuned through phases
 * 1–5. Any baked world without a `params` column row gets these.
 */
export const DEFAULT_GEN_PARAMS: GenParams = {
  biome: {
    frequency: 1 / 6,
    octaves: 3,
  },
  river: {
    sourceAltitude: 0.62,
    minSeparation: 2,
    widthPixels: 2,
  },
  noise: {
    baseFrequency: 0.02,
    extraFrequencyPerRuggedness: 0.02,
    baseThreshold: -0.10,
    extraThresholdPerRuggedness: 0.30,
    octaves: 3,
  },
  terrain: {
    wallHeight: 3.0,
    floorBaseline: 0.0,
    floorModAmplitude: 1.5,
    floorModFrequency: 0.04,
  },
  materials: {
    detailFrequency: 0.06,
    stoneAltitudeStrict: 0.78,
    stoneAltitudeRugged: 0.65,
    stoneRuggednessThreshold: 0.70,
    sandTemperature: 0.65,
    sandMoisture: 0.30,
    waterMoisture: 0.60,
    waterAltitude: 0.55,
    waterDetail: 0.60,
    grassMoisture: 0.40,
  },
  kinds: {
    detailFrequency: 0.05,
    cliffAltitudeStrict: 0.65,
    cliffAltitudeRugged: 0.50,
    cliffRuggednessThreshold: 0.60,
    waterMoisture: 0.65,
    waterAltitude: 0.45,
    waterDetail: 0.55,
    vegetationMoisture: 0.30,
  },
};

/**
 * Deep-merge a Partial<GenParams> override on top of the defaults.
 * Each top-level slice can be partially overridden — leaves unspecified
 * fields at their default value.
 *
 * Designed for the bake flow: callers pass whatever subset they want to
 * change; the rest comes from DEFAULT_GEN_PARAMS. The merged result is
 * what gets persisted on the world row.
 */
export function mergeGenParams(override?: Partial<DeepPartialGenParams>): GenParams {
  if (!override) return cloneParams(DEFAULT_GEN_PARAMS);
  const out = cloneParams(DEFAULT_GEN_PARAMS);
  for (const slice of Object.keys(out) as (keyof GenParams)[]) {
    const ov = override[slice];
    if (!ov) continue;
    Object.assign(out[slice], ov);
  }
  return out;
}

function cloneParams(p: GenParams): GenParams {
  // Shallow-clone each slice (all leaves are numbers — no nested objects).
  return {
    biome:     { ...p.biome },
    river:     { ...p.river },
    noise:     { ...p.noise },
    terrain:   { ...p.terrain },
    materials: { ...p.materials },
    kinds:     { ...p.kinds },
  };
}

type DeepPartialGenParams = {
  [K in keyof GenParams]?: Partial<GenParams[K]>;
};

export type { DeepPartialGenParams };
