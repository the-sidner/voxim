/**
 * Stage 12 — render-field derivation (T-311 Phase 3, commit 2 core). Pure, deterministic
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
import { fbm } from "@voxim/levelgen";
import { BoundaryKind } from "@voxim/protocol";
import { materialVariantIds } from "@voxim/content";
import type { ContentService } from "@voxim/content";
import { RIVER_DEPTH } from "./terrain.ts";
import { ZONE_ID_NONE } from "./state.ts";
import type { CliffState, FieldsState } from "./state.ts";

/** Own fbm channel for the fertility dapple (noise stage uses …3001). */
const DAPPLE_SUB_SEED = 0x30003002;

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
  /** fertility dapple: mid-frequency fbm modulation [1-amp, 1+amp] so wilderness
   *  fertility is PATCHY (groves / clearings / sparse scrub) instead of flat —
   *  without it the formula below is near-constant outside chambers and every
   *  fertility-driven scatter reads as a uniform carpet (or nothing). 0 = off. */
  fertilityDappleAmp: number;
  fertilityDappleScale: number;  // fbm frequency per cell (~1/feature-size)
  wearFromTraffic: number;         // wear = pathLevel × this
  corruptionRuinAgeWeight: number; // corruption = ruinAge × this + dryness bias
  fertilityCanopyBase: number;     // fertility canopy term: base + gain × canopyLight
  fertilityCanopyGain: number;
  fertilityCorruptionDamp: number; // fertility corruption term: 1 - damp × corruption
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
  /**
   * Stable alphabetical index of the "corrupted" `MaterialVariant` on the
   * `stone` MaterialDef (I3c — SAME `materialVariantIds()` table the client
   * resolves `SurfaceStateGrid.variantIndex` through), resolved via
   * `materialVariantIds()` — NOT a raw literal (T-319). -1 when no content
   * store is available (unit tests / a content-less pipeline run) or the
   * `stone` material has no "corrupted" variant; the derivation then leaves
   * every cell at index 0 ("base"), mirroring `cliffStage`'s "no-op without
   * content" stance.
   */
  corruptedVariantIdx: number;
  /** Tunable derivation weights. */
  params: FieldParams;
}

/**
 * The 10-plane render-field bundle. Field set is a deliberate parallel
 * contract with world's FieldsBufferInput (packages/world/src/generator.ts)
 * — atlas and world cannot import each other, so tile-server's
 * atlas_terrain.ts bridges the two by passing a FieldPlanes value where
 * FieldsBufferInput is expected; TypeScript's structural typing enforces
 * the two interfaces stay field-compatible at that call site. Update both
 * together when adding/removing a plane.
 */
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
  const { gridSize, kindOf, heightMap, chamberOf, pathLevel, moisture, tileSeed, corruptedVariantIdx, params } = input;
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
    if (kindOf[i] === BoundaryKind.forest) forestSeed[i] = 255;
    if (kindOf[i] === BoundaryKind.water) {
      waterSeed[i] = 255;
      surfaceLevel[i] = heightMap[i] + RIVER_DEPTH; // surface sits above the cut channel
    }
  }
  const forestShadow = spread(forestSeed, gridSize, params.forestShadowPasses, params.forestShadowDecay);
  const waterNear = spread(waterSeed, gridSize, params.waterSpreadPasses, params.waterSpreadDecay);

  const moist255 = clamp255(moisture * 255);

  const dAmp = params.fertilityDappleAmp;
  const dScale = params.fertilityDappleScale;

  for (let i = 0; i < n; i++) {
    const x = i % gridSize, y = (i / gridSize) | 0;
    // canopyLight: open sky 255, low under (and near) forest canopy.
    canopyLight[i] = clamp255(255 - forestShadow[i]);

    // ruinAge: per-chamber deterministic age (0 outside chambers). Drives the
    // "oldest stone most swallowed" reads.
    const chamber = chamberOf[i];
    ruinAge[i] = chamber === 0 ? 0 : hash255(chamber, tileSeed);

    // traffic = the rasterised path level; wear follows traffic.
    traffic[i] = pathLevel[i];
    wear[i] = clamp255(pathLevel[i] * params.wearFromTraffic);

    // corruption: old chambers corrupt; biased a little by dryness.
    corruption[i] = clamp255(ruinAge[i] * params.corruptionRuinAgeWeight + (1 - moisture) * params.corruptionDrynessBias);

    // wetness: near water + the tile's ambient moisture.
    wetness[i] = clamp255(Math.max(waterNear[i], moist255 * 0.5));

    // fertility: moisture × dappled light × (low corruption), modulated by the
    // mid-frequency dapple fbm. The scatter-density basis — the dapple is what
    // lets groundcover/groves vary ORGANICALLY across otherwise-uniform
    // wilderness (canopyLight is flat 0 inside forest, moisture is per-tile).
    const dapple = dAmp <= 0 ? 1
      : 1 - dAmp + 2 * dAmp * fbm(x * dScale, y * dScale, tileSeed ^ DAPPLE_SUB_SEED, 3);
    fertility[i] = clamp255(
      moist255 *
        (params.fertilityCanopyBase + params.fertilityCanopyGain * canopyLight[i] / 255) *
        (1 - params.fertilityCorruptionDamp * corruption[i] / 255) *
        dapple,
    );

    // overgrowth: moss creep on old, untrodden, corrupt stone.
    overgrowth[i] = clamp255(
      (corruption[i] / 255) * (ruinAge[i] / 255) * (1 - traffic[i] / 255) * 255,
    );

    // variantIndex: two-state v1 — base (0) vs the resolved "corrupted"
    // MaterialVariant's stable alphabetical index past a threshold (I3c;
    // T-319). corruptedVariantIdx < 0 (no content / no such variant) leaves
    // every cell at the "base" index 0, matching cliffStage's content-less
    // all-zero stance.
    variantIndex[i] = corruptedVariantIdx >= 0 && corruption[i] > params.variantCorruptThreshold
      ? corruptedVariantIdx
      : 0;
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
export const fieldsStage: Transformer<CliffState, FieldsState, FieldParams> =
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
    // T-319: resolve "corrupted" through the SAME stable alphabetical
    // id→index table (`materialVariantIds`) the client resolves
    // `SurfaceStateGrid.variantIndex` through — not a bare literal `1`. -1
    // (no content / stone has no "corrupted" variant) leaves variantIndex at
    // 0 for every cell, mirroring `cliffStage`'s content-less stance.
    const stone = state.content?.materials.get("stone");
    const corruptedVariantIdx = stone ? materialVariantIds(stone).indexOf("corrupted") : -1;
    const fields = deriveFieldPlanes({
      gridSize: state.gridSize,
      kindOf: state.kindOf,
      heightMap: state.heightMap,
      chamberOf: state.chamberOf,
      pathLevel,
      moisture: state.worldCell.biome.moisture,
      tileSeed: seed,
      corruptedVariantIdx,
      params,
    });
    return { ...state, fields };
  };

/**
 * Atlas boot cross-check (T-319, I3c) — the `stone` MaterialDef must carry a
 * "corrupted" variant, so `fieldsStage`'s `materialVariantIds(stone).indexOf
 * ("corrupted")` resolves to a real index instead of silently degrading to
 * -1 (every cell frozen at the "base" variantIndex regardless of corruption).
 * Fail-fast at content load, mirroring `crossCheckCliffVoxelisers`'s
 * "resolves through a real content lookup" contract on the client side.
 */
export function crossCheckVariantIndex(content: ContentService): void {
  const stone = content.materials.get("stone");
  if (!stone) {
    throw new Error(`[fields] no "stone" MaterialDef loaded — SurfaceStateGrid.variantIndex needs it.`);
  }
  if (!materialVariantIds(stone).includes("corrupted")) {
    throw new Error(
      `[fields] "stone" MaterialDef has no "corrupted" variant — SurfaceStateGrid.variantIndex ` +
      `would silently stay 0 (base) for every cell (variants: ${materialVariantIds(stone).join(", ") || "none"}).`,
    );
  }
}
