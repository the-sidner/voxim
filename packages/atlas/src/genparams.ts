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
    /**
     * Per-channel additive offset applied AFTER the fbm sample. Use to
     * push the whole world wetter / drier / higher / etc. before any
     * downstream rule runs. Final value clamped to [0, 1] per channel.
     *
     * Examples:
     *   biasMoisture = +0.3 → forested everywhere (vegetation kind dominates)
     *   biasAltitude = +0.4 → mountainy everywhere (cliff kind dominates)
     *   biasMoisture = -0.3 → arid; sand + dirt materials, cliff walls
     */
    biasTemperature: number;
    biasMoisture: number;
    biasAltitude: number;
    biasRuggedness: number;
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

  /**
   * Room-extraction stage. Cleans the raw noise blobs into usable rooms:
   * drops the speckle (one-pixel blobs that aren't real rooms), optionally
   * dilates the keepers so cramped blobs become walkable.
   */
  room: {
    /** Drop connected open blobs smaller than this many pixels. */
    minPixelArea: number;
    /** Number of binary dilation passes (4-conn) on retained blobs. 0 = none. */
    dilatePasses: number;
  };

  /**
   * Room-network stage. Plans corridors between rooms.
   *
   * Pipeline: Delaunay triangulation over room centroids → MST for guaranteed
   * connectivity → keep `loopRate` of the remaining edges as braids. Each
   * chosen edge is carved via A* using the noise field as cost so corridors
   * follow the weakest walls and never read as straight cuts.
   */
  network: {
    /** Cap on Delaunay edge length, in pixels. Longer candidates are dropped. */
    maxEdgeLength: number;
    /** Fraction of non-tree Delaunay edges kept as loops. 0 = tree, 1 = full net. */
    loopRate: number;
    /** Carved-corridor half-width, in pixels. 0 = single-pixel path. */
    corridorWidth: number;
    /** Multiplier on per-cell noise cost during A*. Higher → straighter carves. */
    noiseCostScale: number;
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
 * Defaults — biased toward the "forest maze" feel:
 *   - noise tuned to FRAGMENT into many distinct open blobs (the rooms),
 *     not to draw connected paths. The network stage rebuilds connectivity
 *     deliberately: MST + braid + noise-flow A* carve.
 *   - vegetation as the default closed kind (low vegetationMoisture cutoff)
 *   - moisture biased up so most cells are forested
 *   - moderate wall height (not tall enough to look cliff-y)
 */
export const DEFAULT_GEN_PARAMS: GenParams = {
  biome: {
    frequency: 1 / 6,
    octaves: 3,
    biasTemperature: 0,
    biasMoisture: 0.20,    // push forest-y
    biasAltitude: -0.10,   // pull a bit lower so cliffs don't dominate
    biasRuggedness: 0,
  },
  river: {
    sourceAltitude: 0.55,  // more sources → more rivers
    minSeparation: 2,
    widthPixels: 2,
  },
  noise: {
    baseFrequency: 0.04,                 // bigger blobs → readable rooms
    extraFrequencyPerRuggedness: 0.02,
    baseThreshold: 0.10,                 // POSITIVE → fragments into many blobs
    extraThresholdPerRuggedness: 0.10,
    octaves: 4,
  },
  terrain: {
    wallHeight: 3.0,
    floorBaseline: 0.0,
    floorModAmplitude: 1.5,
    floorModFrequency: 0.04,
  },
  room: {
    minPixelArea: 12,                    // ~< 0.75% of grid → speckle, drop
    dilatePasses: 0,
  },
  network: {
    maxEdgeLength: 64,                   // half the grid; cap intra-tile reach
    loopRate: 0.45,                      // explorative; ~half of non-tree edges
    corridorWidth: 1,
    noiseCostScale: 8,
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
    cliffAltitudeStrict: 0.75,           // cliffs only at very high altitude
    cliffAltitudeRugged: 0.65,
    cliffRuggednessThreshold: 0.70,
    waterMoisture: 0.65,
    waterAltitude: 0.45,
    waterDetail: 0.55,
    vegetationMoisture: 0.10,            // almost everything is forest
  },
};

// ---- named presets -------------------------------------------------------
//
// Each preset is a complete GenParams snapshot. The inspector exposes them
// as a dropdown so designers can jump between named configurations and then
// tweak from there. Presets are deliberately strong shapes (the differences
// between them should be visible at a glance), not subtle variations.

export const PRESETS: Record<string, { name: string; description: string; params: GenParams }> = {
  forest_maze: {
    name: "Forest maze",
    description: "Dense forest with thin winding open paths. The default vision.",
    params: DEFAULT_GEN_PARAMS,
  },
  open_plains: {
    name: "Open plains",
    description: "Few big rooms, sparse tree clusters, wide corridors. Easy to traverse.",
    params: {
      ...DEFAULT_GEN_PARAMS,
      biome: { ...DEFAULT_GEN_PARAMS.biome, biasMoisture: 0.05, biasAltitude: -0.20 },
      noise: {
        baseFrequency: 0.02,                // big features → big blobs
        extraFrequencyPerRuggedness: 0.01,
        baseThreshold: 0.30,                // strongly open
        extraThresholdPerRuggedness: 0.10,
        octaves: 3,
      },
      room: { minPixelArea: 80, dilatePasses: 1 },
      network: { maxEdgeLength: 96, loopRate: 0.20, corridorWidth: 2, noiseCostScale: 4 },
      kinds: { ...DEFAULT_GEN_PARAMS.kinds, vegetationMoisture: 0.10 },
    },
  },
  cliff_dungeon: {
    name: "Cliff dungeon",
    description: "Many small rooms, dense interwoven corridors. Reads like a stone labyrinth.",
    params: {
      ...DEFAULT_GEN_PARAMS,
      biome: { ...DEFAULT_GEN_PARAMS.biome, biasAltitude: 0.40, biasRuggedness: 0.20, biasMoisture: -0.10 },
      noise: {
        baseFrequency: 0.06,                // small features → many small blobs
        extraFrequencyPerRuggedness: 0.02,
        baseThreshold: 0.25,
        extraThresholdPerRuggedness: 0.10,
        octaves: 4,
      },
      room: { minPixelArea: 8, dilatePasses: 0 },
      network: { maxEdgeLength: 40, loopRate: 0.70, corridorWidth: 1, noiseCostScale: 12 },
      terrain: { ...DEFAULT_GEN_PARAMS.terrain, wallHeight: 5.0 },
      kinds: {
        ...DEFAULT_GEN_PARAMS.kinds,
        cliffAltitudeStrict: 0.30,
        cliffAltitudeRugged: 0.20,
        cliffRuggednessThreshold: 0.30,
        vegetationMoisture: 0.80,           // vegetation rare
      },
    },
  },
  wet_marsh: {
    name: "Wet marsh",
    description: "Mid-size rooms in dense vegetation, wider corridors meandering past water.",
    params: {
      ...DEFAULT_GEN_PARAMS,
      biome: { ...DEFAULT_GEN_PARAMS.biome, biasMoisture: 0.40, biasAltitude: -0.30 },
      river: { sourceAltitude: 0.40, minSeparation: 1, widthPixels: 3 },
      noise: {
        baseFrequency: 0.035,
        extraFrequencyPerRuggedness: 0.01,
        baseThreshold: 0.15,
        extraThresholdPerRuggedness: 0.10,
        octaves: 3,
      },
      room: { minPixelArea: 16, dilatePasses: 1 },
      network: { maxEdgeLength: 64, loopRate: 0.45, corridorWidth: 2, noiseCostScale: 6 },
      kinds: {
        ...DEFAULT_GEN_PARAMS.kinds,
        waterMoisture: 0.40, waterAltitude: 0.60, waterDetail: 0.30,
        vegetationMoisture: 0.05,
      },
    },
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
    room:      { ...p.room },
    network:   { ...p.network },
    materials: { ...p.materials },
    kinds:     { ...p.kinds },
  };
}

type DeepPartialGenParams = {
  [K in keyof GenParams]?: Partial<GenParams[K]>;
};

export type { DeepPartialGenParams };
