/**
 * Render-field derivation (T-311 Phase 3, commit 2 core). Pure, deterministic
 * `signals → 10 per-cell planes` for the VegFieldGrid / SurfaceStateGrid /
 * WaterGrid chunk components. Computed at atlas `gridSize` from data the pipeline
 * already produces (kindOf, heightMap, chamberOf) + a per-cell path level the
 * stage rasterises from the zone graph, plus the two signals that did NOT exist
 * before this phase: a seed-deterministic chamber AGE and traffic (= pathLevel).
 *
 * The FORMULAS here are deliberately simple v1 — they are meant to be TUNED
 * against the Atlas-inspector heat overlays (commit 3), which is why this is a
 * pure function with no pipeline coupling: the stage (commit 2b) calls it, the
 * inspector re-runs it live with slider weights, and a unit test pins its
 * structural properties (water → finite level, forest → low canopyLight, chamber
 * → non-zero ruinAge, path → traffic). NEVER read for collision.
 */
import type { Transformer } from "@voxim/levelgen";
import { BOUNDARY_KIND_FOREST, BOUNDARY_KIND_WATER } from "./boundary_kinds.ts";
import { RIVER_DEPTH } from "./terrain.ts";
import { ZONE_ID_NONE } from "./state.ts";
import type { PoiNetworkState, FieldsState } from "./state.ts";

/** Tunable derivation weights (the Atlas-inspector sliders edit these). Mirrors
 *  the `GenParams["fields"]` slice; kept here so `deriveFieldPlanes` stays a pure,
 *  testable core decoupled from genparams. */
export interface FieldParams {
  forestShadowPasses: number;    // canopyLight: how far the canopy shadow spreads
  forestShadowDecay: number;     // …and its per-cell falloff
  waterSpreadPasses: number;     // wetness: how far damp ground reaches from water
  waterSpreadDecay: number;
  corruptionDrynessBias: number; // dry tiles read more corrupt (0..255 added at moisture 0)
  variantCorruptThreshold: number; // corruption above this → the "corrupted" variant index
}

export interface FieldDeriveInput {
  gridSize: number;
  /** BOUNDARY_KIND_* per cell, length gridSize². */
  kindOf: Uint16Array;
  /** Floor heights per cell. */
  heightMap: Float32Array;
  /** Chamber id per cell (0 = no chamber). */
  chamberOf: Uint16Array;
  /** Per-cell path intensity 0..255 (wilderness=0 … corridor=255), rasterised
   *  from the zone graph by the calling stage. Becomes `traffic`. */
  pathLevel: Uint8Array;
  /** Tile biome moisture 0..1 (per-tile scalar). */
  moisture: number;
  /** Tile seed for the deterministic chamber-age hash. */
  tileSeed: number;
  /** Tunable derivation weights. */
  params: FieldParams;
}

export interface FieldPlanes {
  canopyLight: Uint8Array;
  corruption: Uint8Array;
  fertility: Uint8Array;
  wetness: Uint8Array;
  overgrowth: Uint8Array;
  wear: Uint8Array;
  variantIndex: Uint8Array;
  ruinAge: Uint8Array;
  traffic: Uint8Array;
  surfaceLevel: Float32Array;
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v) | 0;

/** Deterministic 0..255 hash of two integers (mulberry-ish, pure). */
function hash255(a: number, b: number): number {
  let n = (Math.imul(a, 374761393) ^ Math.imul(b, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) & 0xff;
}

/**
 * Grassfire-style soft spread: seed cells keep their value; each pass dilates,
 * taking `decay ×` the max 4-neighbour. After `passes` passes the influence
 * reaches `passes` cells out with a falloff. Pure; allocates one scratch buffer.
 */
function spread(seed: Uint8Array, gridSize: number, passes: number, decay: number): Uint8Array {
  let cur = Uint8Array.from(seed);
  let next = new Uint8Array(cur.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const i = x + y * gridSize;
        let m = cur[i];
        if (x > 0) m = Math.max(m, cur[i - 1] * decay);
        if (x < gridSize - 1) m = Math.max(m, cur[i + 1] * decay);
        if (y > 0) m = Math.max(m, cur[i - gridSize] * decay);
        if (y < gridSize - 1) m = Math.max(m, cur[i + gridSize] * decay);
        next[i] = m | 0;
      }
    }
    const t = cur; cur = next; next = t;
  }
  return cur;
}

export function deriveFieldPlanes(input: FieldDeriveInput): FieldPlanes {
  const { gridSize, kindOf, heightMap, chamberOf, pathLevel, moisture, tileSeed, params } = input;
  const n = gridSize * gridSize;

  const canopyLight = new Uint8Array(n);
  const corruption = new Uint8Array(n);
  const fertility = new Uint8Array(n);
  const wetness = new Uint8Array(n);
  const overgrowth = new Uint8Array(n);
  const wear = new Uint8Array(n);
  const variantIndex = new Uint8Array(n);
  const ruinAge = new Uint8Array(n);
  const traffic = new Uint8Array(n);
  const surfaceLevel = new Float32Array(n).fill(NaN);

  // Seed masks for the spreads.
  const forestSeed = new Uint8Array(n);
  const waterSeed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (kindOf[i] === BOUNDARY_KIND_FOREST) forestSeed[i] = 255;
    if (kindOf[i] === BOUNDARY_KIND_WATER) {
      waterSeed[i] = 255;
      surfaceLevel[i] = heightMap[i] + RIVER_DEPTH; // surface sits above the cut channel
    }
  }
  const forestShadow = spread(forestSeed, gridSize, params.forestShadowPasses, params.forestShadowDecay);
  const waterNear = spread(waterSeed, gridSize, params.waterSpreadPasses, params.waterSpreadDecay);

  const moist255 = clamp255(moisture * 255);

  for (let i = 0; i < n; i++) {
    // canopyLight: open sky 255, low under (and near) forest canopy.
    canopyLight[i] = clamp255(255 - forestShadow[i]);

    // ruinAge: per-chamber deterministic age (0 outside chambers). Drives the
    // "oldest stone most swallowed" reads.
    const chamber = chamberOf[i];
    ruinAge[i] = chamber === 0 ? 0 : hash255(chamber, tileSeed);

    // traffic = the rasterised path level; wear follows traffic.
    traffic[i] = pathLevel[i];
    wear[i] = clamp255(pathLevel[i] * 0.85);

    // corruption: old chambers corrupt; biased a little by dryness.
    corruption[i] = clamp255(ruinAge[i] * 0.6 + (1 - moisture) * params.corruptionDrynessBias);

    // wetness: near water + the tile's ambient moisture.
    wetness[i] = clamp255(Math.max(waterNear[i], moist255 * 0.5));

    // fertility: moisture × dappled light × (low corruption). The scatter-density basis.
    fertility[i] = clamp255(
      moist255 * (0.4 + 0.6 * canopyLight[i] / 255) * (1 - 0.5 * corruption[i] / 255),
    );

    // overgrowth: moss creep on old, untrodden, corrupt stone.
    overgrowth[i] = clamp255(
      (corruption[i] / 255) * (ruinAge[i] / 255) * (1 - traffic[i] / 255) * 255,
    );

    // variantIndex: two-state v1 — base (0) vs corrupted (1) past a threshold.
    variantIndex[i] = corruption[i] > params.variantCorruptThreshold ? 1 : 0;
  }

  return { canopyLight, corruption, fertility, wetness, overgrowth, wear, variantIndex, ruinAge, traffic, surfaceLevel };
}

// ---- pipeline stage --------------------------------------------------------

/**
 * The `fields` pipeline stage (T-311 P3 commit 2b). Rasterises a per-cell path
 * level from the annotated zone graph (corridor=255, path-zone=160, wilderness=0)
 * then runs the pure `deriveFieldPlanes`. Produces `state.fields` — read by the
 * Atlas inspector (heat overlays / tuning) now and threaded to the chunk grids +
 * re-bake in a follow-up. Adds no mutation to the existing buffers.
 */
export const fieldsStage: Transformer<PoiNetworkState, FieldsState, FieldParams> =
  (state, seed, params) => {
    const n = state.gridSize * state.gridSize;
    const pathLevel = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const z = state.zoneOf[i];
      if (z === ZONE_ID_NONE) continue;
      const zone = state.zones[z];
      if (!zone || zone.traversal !== "path") continue;
      pathLevel[i] = zone.isCorridor ? 255 : 160;
    }
    const fields = deriveFieldPlanes({
      gridSize: state.gridSize,
      kindOf: state.kindOf,
      heightMap: state.heightMap,
      chamberOf: state.chamberOf,
      pathLevel,
      moisture: state.worldCell.biome.moisture,
      tileSeed: seed,
      params,
    });
    return { ...state, fields };
  };
