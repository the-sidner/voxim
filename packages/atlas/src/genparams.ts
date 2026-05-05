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
   * Chamber stage. Places N seeds via Poisson-disk sampling, then grows
   * each into an organic shape via priority-flood. The growth cost per
   * pixel is `noise[p] + compactness · |p − seed|`, so chambers accrete
   * volume around the seed (the compactness term) while still picking
   * up organic outline detail from the noise field. Round-robin growth
   * lets adjacent chambers compete fairly for shared territory.
   *
   * Tuning intuitions:
   *   compactness = 0   → chambers follow noise lobes (snake shapes)
   *   compactness = 0.3 → organic but chunky (room-sized blobs)
   *   compactness = 1.0 → essentially Voronoi cells (round, no character)
   */
  room: {
    /** Target chamber count per tile. Poisson sampler aims for this many. */
    targetCount: number;
    /** Min separation between chamber seeds, in pixels. */
    minSeparation: number;
    /** Per-chamber size range, in pixel cells. */
    sizeMin: number;
    sizeMax: number;
    /**
     * Strength of the distance-from-seed cost component during growth.
     * Higher = chambers stay tighter around their seed (round); lower =
     * chambers stretch into low-noise lobes (irregular).
     */
    compactness: number;
  };

  /**
   * Network stage. Plans corridors between chambers.
   *
   * Pipeline: Delaunay triangulation over chamber centroids → Kruskal MST
   * for guaranteed connectivity → keep `loopRate` of the non-tree edges
   * as braids → for each kept edge, ray-march from each centroid toward
   * the partner to find the chamber-boundary entry/exit pixels (so the
   * carve enters and exits at the chamber walls instead of crossing the
   * interior) → generate `segments + 1` waypoints along the line, with
   * interior waypoints perpendicular-perturbed by `curvature × edge_len`
   * and clamped to a tile-interior margin → sweep a Catmull-Rom spline
   * through the waypoints (each segment becomes a cubic bezier; C1
   * continuous at joints) → stamp brush of `widthMin..widthMax` along
   * the curve.
   */
  network: {
    /** Cap on Delaunay edge length, in pixels. Longer candidates are dropped. */
    maxEdgeLength: number;
    /** Fraction of non-tree Delaunay edges kept as loops. 0 = tree, 1 = full net. */
    loopRate: number;
    /**
     * Per-edge brush half-width range, in pixels. 0 = 1px wide path, 1 =
     * 3px, 2 = 5px. Each edge picks its own width uniformly from this range.
     */
    widthMin: number;
    widthMax: number;
    /**
     * Number of spline segments per corridor (waypoints = segments + 1).
     * 1 = single straight-ish bezier; 4 = visibly winding path; 8 = very
     * twisty.
     */
    segments: number;
    /**
     * Per-waypoint perpendicular perturbation, as a fraction of edge
     * length. The actual displacement is `curvature × edge_length × random
     * × sin(π·t)` so endpoints stay anchored. 0 = straight polyline; 0.3
     * = visible S-bends; 0.6 = dramatic switchbacks.
     */
    curvature: number;
    /**
     * Bezier samples per spline segment. Higher = denser stamping =
     * smoother carve at the cost of CPU. With segments=4 and samples=50,
     * total stamps per corridor = 200.
     */
    bezierSamples: number;
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
 *   - 7 chambers per tile with organic noise-derived silhouettes,
 *     connected by curving variable-width corridors.
 *   - noise field is now used purely as a *cost surface* (chamber growth
 *     prefers low-noise pixels). The threshold knob in `noise` is
 *     vestigial under this approach but kept so other consumers
 *     (boundary kinds, materials) still have their hooks.
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
    // Frequency is per-pixel; bumped down 4× now that pixels are 4× smaller
    // so noise features stay at the same world-scale.
    baseFrequency: 0.0125,
    extraFrequencyPerRuggedness: 0.005,
    baseThreshold: 0.0,
    extraThresholdPerRuggedness: 0.10,
    octaves: 5,
  },
  terrain: {
    wallHeight: 3.0,
    floorBaseline: 0.0,
    floorModAmplitude: 1.5,
    floorModFrequency: 0.01,
  },
  room: {
    targetCount: 7,
    minSeparation: 128,                  // ~25% of tile width between seeds
    sizeMin: 5000,                       // ~70×70 chamber
    sizeMax: 9500,                       // ~95×100 chamber
    compactness: 0.35,                   // gridSize-invariant (world units)
  },
  network: {
    maxEdgeLength: 360,                  // ~70% of tile size
    loopRate: 0.55,
    widthMin: 1,                         // 3 wu wide
    widthMax: 3,                         // up to 7 wu wide
    segments: 4,
    curvature: 0.18,
    bezierSamples: 200,                  // per segment → 800 stamps total
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
    description: "A few large clearings linked by short, wide, near-straight paths.",
    params: {
      ...DEFAULT_GEN_PARAMS,
      biome: { ...DEFAULT_GEN_PARAMS.biome, biasMoisture: 0.05, biasAltitude: -0.20 },
      noise: {
        baseFrequency: 0.006,
        extraFrequencyPerRuggedness: 0.0025,
        baseThreshold: 0.0,
        extraThresholdPerRuggedness: 0.05,
        octaves: 4,
      },
      room: { targetCount: 4, minSeparation: 175, sizeMin: 9500, sizeMax: 17500, compactness: 0.50 },
      network: { maxEdgeLength: 480, loopRate: 0.30, widthMin: 2, widthMax: 5, segments: 3, curvature: 0.10, bezierSamples: 240 },
      kinds: { ...DEFAULT_GEN_PARAMS.kinds, vegetationMoisture: 0.10 },
    },
  },
  cliff_dungeon: {
    name: "Cliff dungeon",
    description: "Many tight chambers, twisty narrow corridors. Reads like a stone labyrinth.",
    params: {
      ...DEFAULT_GEN_PARAMS,
      biome: { ...DEFAULT_GEN_PARAMS.biome, biasAltitude: 0.40, biasRuggedness: 0.20, biasMoisture: -0.10 },
      noise: {
        baseFrequency: 0.0175,
        extraFrequencyPerRuggedness: 0.005,
        baseThreshold: 0.0,
        extraThresholdPerRuggedness: 0.05,
        octaves: 6,
      },
      room: { targetCount: 12, minSeparation: 80, sizeMin: 2200, sizeMax: 4200, compactness: 0.25 },
      network: { maxEdgeLength: 220, loopRate: 0.85, widthMin: 0, widthMax: 1, segments: 5, curvature: 0.35, bezierSamples: 200 },
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
    description: "Mid-size irregular chambers in vegetation, broad meandering paths past water.",
    params: {
      ...DEFAULT_GEN_PARAMS,
      biome: { ...DEFAULT_GEN_PARAMS.biome, biasMoisture: 0.40, biasAltitude: -0.30 },
      river: { sourceAltitude: 0.40, minSeparation: 1, widthPixels: 3 },
      noise: {
        baseFrequency: 0.011,
        extraFrequencyPerRuggedness: 0.0025,
        baseThreshold: 0.0,
        extraThresholdPerRuggedness: 0.05,
        octaves: 5,
      },
      room: { targetCount: 6, minSeparation: 120, sizeMin: 6000, sizeMax: 12000, compactness: 0.30 },
      network: { maxEdgeLength: 360, loopRate: 0.55, widthMin: 2, widthMax: 4, segments: 4, curvature: 0.28, bezierSamples: 220 },
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
