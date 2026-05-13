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
   * Junctions + rooms stages.
   *
   * Junctions: Poisson-disk-sampled point set across the tile. They are
   * the graph nodes the network stage builds Delaunay over; carved
   * corridors land at junction positions.
   *
   * Rooms: AFTER the network is carved, per junction we roll a probability
   *   prob = clamp(roomChanceBase + (degree − 1) · roomChancePerDegree, 0, 1)
   * If the roll succeeds the junction grows a small noise-flooded disk
   * around itself (the priority-flood used to grow the old chambers, but
   * tightly sized). Pass-through junctions (low degree) become invisible
   * bends in the corridor; convergent junctions (high degree) become rooms.
   *
   * Tuning intuitions:
   *   roomChanceBase = 0.05, perDegree = 0.30
   *     → degree 1: 5%, 2: 35%, 3: 65%, 4: 95%, ≥5: 100%
   *   compactness = 0   → rooms follow noise lobes (snake)
   *   compactness = 0.3 → rooms are chunky organic blobs
   *   compactness = 1.0 → rooms are round Voronoi cells
   */
  room: {
    /** Target junction count per tile. Poisson sampler aims for this many. */
    targetCount: number;
    /** Min separation between junction seeds, in pixels. */
    minSeparation: number;
    /** Per-room size range when grown, in pixels. */
    sizeMin: number;
    sizeMax: number;
    /**
     * Strength of the distance-from-seed cost component during room growth.
     * Higher = rooms stay tighter around their junction (round); lower =
     * rooms stretch into low-noise lobes (irregular).
     */
    compactness: number;
    /** Probability a degree-1 junction becomes a room. */
    roomChanceBase: number;
    /** Extra probability per additional degree above 1 (clamped to 1). */
    roomChancePerDegree: number;
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
    /**
     * Per-corridor probability of spawning a branch sub-path off into
     * the wall space. 0 = no branches (just the main MST + braids);
     * 1 = every corridor branches at every level. Branches recurse up
     * to `branchMaxDepth` levels deep, scaling by `branchLengthFraction`
     * each level. They form dead-ends or junctions, depending on whether
     * they happen to hit other carved space.
     */
    branchRate: number;
    /** Max recursion depth for branches. 0 = disabled, 2-3 typical. */
    branchMaxDepth: number;
    /**
     * Each branch's length as a fraction of its parent's length. 0.6
     * means branches at depth 1 are 60% of the main edge, depth 2 are
     * 36%, etc.
     */
    branchLengthFraction: number;
  };

  /** Per-pixel boundary kind (STONE / FOREST / GRASS_MOUND) selectors. */
  kinds: {
    /** Per-pixel detail noise frequency. */
    detailFrequency: number;
    /** Closed pixel: altitude > X → STONE. */
    stoneAltitudeStrict: number;
    /** altitude > X AND ruggedness > Y → STONE. */
    stoneAltitudeRugged: number;
    stoneRuggednessThreshold: number;
    /** moisture > X → FOREST (else falls back to GRASS_MOUND). */
    forestMoisture: number;
    /**
     * Tile-server tree spawn stride for FOREST pixels, in world units.
     * Smaller = denser forest. Tile-server reads this from the world's
     * persisted params at boot.
     */
    forestDensityStride: number;
  };

  /**
   * Topology-role classification thresholds for the AnnotatedZoneGraph
   * (T-208). Each rule is a hard threshold the role-assigner consults
   * in declaration order — first match wins. Defaults match the
   * canonical "forest maze" tile shape; tune up for sparser tiles
   * (raise pocket/lobby area mins) or down for denser ones.
   */
  /**
   * Tier 6 (T-209) POI-network solver knobs. The solver consumes the
   * AnnotatedZoneGraph from T-208 and the POI roster from
   * `packages/content/data/pois/` to weave a per-tile dependency-DAG.
   */
  poiNetwork: {
    /** Target POI count per tile. The matcher tries to hit this exactly. */
    targetPoiCount: number;
    /** Solver retry budget. After this many failures it falls back to a
     *  degraded linear chain through the best-fit candidates. */
    maxRetries: number;
    /** Minimum candidate fit-score to consider a (zone, POI) pairing. */
    minFitScore: number;
    /** Bonus added to a candidate's score per preferred-topology match. */
    preferredTopologyBonus: number;
    /** Cap on the per-tile theme-bridge search depth when wiring keys. */
    maxWireSearchDepth: number;
  };

  zoneGraph: {
    /** area > this → "arena" (high-stakes setpiece) */
    arenaAreaMin: number;
    /** degree ≥ 3 + aspectRatio > X + area > Y → "plaza" */
    plazaAreaMin: number;
    plazaAspectRatioMin: number;
    /** degree ≥ 3 + area ≤ this → "crossroads" (path junction, small) */
    crossroadsAreaMax: number;
    /** degree == 2 + area > this → "lobby" (mid-chamber on a corridor) */
    lobbyAreaMin: number;
    /** degree == 2 + area ≤ X + aspectRatio < Y → "corridor" */
    corridorAreaMax: number;
    corridorAspectRatioMax: number;
    /** degree == 1 + area > this → "pocket" (worth visiting cul-de-sac) */
    pocketAreaMin: number;
    /** Everything else with degree ≤ 1 → "deadend". */
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
    baseFrequency: 0.022,                // smaller features → noise sculpts chamber walls
    extraFrequencyPerRuggedness: 0.008,
    baseThreshold: 0.0,
    extraThresholdPerRuggedness: 0.10,
    octaves: 5,
  },
  terrain: {
    // Closed pixels stay at floor height by default — visual contrast is
    // carried by darker materials + tree entities, not by a vertical step.
    // All three wall kinds (STONE, FOREST, GRASS_MOUND) rise by this
    // amount. Must exceed runtime stepHeight (0.75u) so players can't
    // walk over walls. WATER and OPEN stay at floor height.
    wallHeight: 2.0,
    floorBaseline: 0.0,
    floorModAmplitude: 1.5,
    floorModFrequency: 0.01,
  },
  room: {
    targetCount: 14,                     // more junctions → more graph nodes
    minSeparation: 80,
    sizeMin: 200,                        // small "hub" rooms
    sizeMax: 600,
    compactness: 0.10,                   // low → noise can sculpt boundary lobes
    roomChanceBase: 0.05,
    roomChancePerDegree: 0.30,
  },
  network: {
    maxEdgeLength: 320,
    loopRate: 0.85,                      // lots of mainline loops
    widthMin: 1,                         // 3 wu wide
    widthMax: 3,                         // up to 7 wu wide
    segments: 4,
    curvature: 0.18,
    bezierSamples: 200,
    branchRate: 0.65,                    // most corridors spawn at least one branch
    branchMaxDepth: 2,
    branchLengthFraction: 0.55,
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
    stoneAltitudeStrict: 0.75,           // bare rock walls only at very high altitude
    stoneAltitudeRugged: 0.65,
    stoneRuggednessThreshold: 0.70,
    forestMoisture: 0.10,                // almost everything wet enough → forest walls
    /**
     * Tile-server tree spawn stride for FOREST wall pixels, in world units.
     * Smaller = denser forest. Trade-off vs. entity count:
     *   stride 4  → ~5000 trees / fully-forested 512u tile (heavy)
     *   stride 6  → ~2200 trees / fully-forested 512u tile (recommended)
     *   stride 12 → ~600  trees / fully-forested 512u tile (sparse cluster)
     * Read at boot from the world's persisted params.
     */
    forestDensityStride: 6,
  },
  zoneGraph: {
    arenaAreaMin:           1500,
    plazaAreaMin:           400,
    plazaAspectRatioMin:    0.6,
    crossroadsAreaMax:      400,
    lobbyAreaMin:           250,
    corridorAreaMax:        250,
    corridorAspectRatioMax: 0.4,
    pocketAreaMin:          150,
  },
  poiNetwork: {
    targetPoiCount:         4,
    maxRetries:             16,
    minFitScore:            0.1,
    preferredTopologyBonus: 0.5,
    maxWireSearchDepth:     8,
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
        baseFrequency: 0.012,
        extraFrequencyPerRuggedness: 0.0035,
        baseThreshold: 0.0,
        extraThresholdPerRuggedness: 0.05,
        octaves: 4,
      },
      room: {
        targetCount: 8, minSeparation: 130, sizeMin: 600, sizeMax: 1400,
        compactness: 0.18, roomChanceBase: 0.10, roomChancePerDegree: 0.35,
      },
      network: {
        maxEdgeLength: 480, loopRate: 0.40, widthMin: 2, widthMax: 5,
        segments: 3, curvature: 0.10, bezierSamples: 240,
        branchRate: 0.25, branchMaxDepth: 1, branchLengthFraction: 0.40,
      },
      kinds: { ...DEFAULT_GEN_PARAMS.kinds, forestMoisture: 0.10 },
    },
  },
  cliff_dungeon: {
    name: "Cliff dungeon",
    description: "Many tight chambers, twisty narrow corridors. Reads like a stone labyrinth.",
    params: {
      ...DEFAULT_GEN_PARAMS,
      biome: { ...DEFAULT_GEN_PARAMS.biome, biasAltitude: 0.40, biasRuggedness: 0.20, biasMoisture: -0.10 },
      noise: {
        baseFrequency: 0.030,
        extraFrequencyPerRuggedness: 0.008,
        baseThreshold: 0.0,
        extraThresholdPerRuggedness: 0.05,
        octaves: 6,
      },
      room: {
        targetCount: 22, minSeparation: 55, sizeMin: 100, sizeMax: 350,
        compactness: 0.07, roomChanceBase: 0.02, roomChancePerDegree: 0.18,
      },
      network: {
        maxEdgeLength: 220, loopRate: 0.95, widthMin: 0, widthMax: 1,
        segments: 5, curvature: 0.35, bezierSamples: 200,
        branchRate: 0.85, branchMaxDepth: 3, branchLengthFraction: 0.55,
      },
      terrain: { ...DEFAULT_GEN_PARAMS.terrain, wallHeight: 3.0 },
      kinds: {
        ...DEFAULT_GEN_PARAMS.kinds,
        stoneAltitudeStrict: 0.30,
        stoneAltitudeRugged: 0.20,
        stoneRuggednessThreshold: 0.30,
        forestMoisture: 0.80,               // forest rare; mostly grass-mound walls
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
        baseFrequency: 0.020,
        extraFrequencyPerRuggedness: 0.006,
        baseThreshold: 0.0,
        extraThresholdPerRuggedness: 0.05,
        octaves: 5,
      },
      room: {
        targetCount: 12, minSeparation: 80, sizeMin: 350, sizeMax: 800,
        compactness: 0.10, roomChanceBase: 0.05, roomChancePerDegree: 0.30,
      },
      network: {
        maxEdgeLength: 320, loopRate: 0.75, widthMin: 2, widthMax: 4,
        segments: 4, curvature: 0.28, bezierSamples: 220,
        branchRate: 0.55, branchMaxDepth: 2, branchLengthFraction: 0.50,
      },
      kinds: {
        ...DEFAULT_GEN_PARAMS.kinds,
        forestMoisture: 0.05,
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
    materials:  { ...p.materials },
    kinds:      { ...p.kinds },
    zoneGraph:  { ...p.zoneGraph },
    poiNetwork: { ...p.poiNetwork },
  };
}

type DeepPartialGenParams = {
  [K in keyof GenParams]?: Partial<GenParams[K]>;
};

export type { DeepPartialGenParams };
