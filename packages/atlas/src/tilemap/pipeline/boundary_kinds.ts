/**
 * Stage 6 — boundary kinds.
 *
 * Every closed pixel (openMask = 0) gets a boundary kind id that decides
 * how the pixel will eventually render and what player verbs can transform
 * it. Open pixels get BOUNDARY_KIND_OPEN.
 *
 * Three wall kinds in active use, all raised by the terrain stage to the
 * same WALL_HEIGHT (2u, just past the runtime stepHeight so none of them
 * are walkable):
 *
 *   STONE       — bare grey rock walls. Picked when the biome is high
 *                 altitude or rugged enough that exposed rock makes sense.
 *   FOREST      — dense vegetation walls; tile-server spawns tree
 *                 entities on top of these pixels at runtime so the wall
 *                 reads as "you can't push through this wall of trees."
 *   GRASS_MOUND — green grassy berm; the fallback wall when neither of
 *                 the above qualifies.
 *
 * WATER is a separate non-wall kind set by the river-stamping stage; it
 * stays at floor height and isn't picked from biome (rivers carve it).
 *
 * Selection is rule-based on biome params + per-pixel detail noise.
 * Each closed pixel asks: "what kind of obstacle am I?" — and the rule
 * leans on the same biome that drove the noise field, so transitions
 * across the cell-grid feel coherent.
 *
 * Pure function: same (openMask, biome, tileSeed) → same kindOf array.
 */

import { fbm } from "../../common/noise.ts";
import type { BiomeParams } from "../../worldmap/types.ts";
import type { GenParams } from "../../genparams.ts";

/**
 * Atlas's canonical boundary-kind ids. Stable across versions; downstream
 * consumers translate to their own (visual + verb) registry.
 *
 * 0 reserved for "open / not a boundary" so a fresh Uint16Array reads as
 * un-tagged before the stage runs.
 */
export const BOUNDARY_KIND_OPEN        = 0;
export const BOUNDARY_KIND_STONE       = 1;
export const BOUNDARY_KIND_FOREST      = 2;
export const BOUNDARY_KIND_WATER       = 3;
export const BOUNDARY_KIND_GRASS_MOUND = 4;
// Room left in the id space for future kinds (rubble, scree, hedge, …).

export interface BoundaryKindsInput {
  openMask: Uint8Array;
  biome: BiomeParams;
  tileSeed: number;
  gridSize: number;
  params: GenParams["kinds"];
}

export interface BoundaryKindsOutput {
  /** Length gridSize², row-major. Open pixels = 0; closed pixels = a kind id. */
  kindOf: Uint16Array;
}

const KIND_SUB_SEED = 0x60006001;

export function runBoundaryKinds(input: BoundaryKindsInput): BoundaryKindsOutput {
  const { openMask, biome, tileSeed, gridSize, params } = input;
  const N = gridSize * gridSize;
  const kindOf = new Uint16Array(N);
  const f = params.detailFrequency;

  for (let py = 0; py < gridSize; py++) {
    for (let px = 0; px < gridSize; px++) {
      const idx = py * gridSize + px;
      if (openMask[idx] === 1) {
        kindOf[idx] = BOUNDARY_KIND_OPEN;
        continue;
      }
      const detail = fbm(px * f, py * f, tileSeed ^ KIND_SUB_SEED, 2);
      kindOf[idx] = pickKind(biome, detail, params);
    }
  }

  return { kindOf };
}

function pickKind(
  b: BiomeParams,
  detail: number,
  p: GenParams["kinds"],
): number {
  if (b.altitude > p.stoneAltitudeStrict) return BOUNDARY_KIND_STONE;
  if (b.altitude > p.stoneAltitudeRugged && b.ruggedness > p.stoneRuggednessThreshold) return BOUNDARY_KIND_STONE;
  if (b.moisture > p.forestMoisture) return BOUNDARY_KIND_FOREST;
  // Detail noise is unused in the wall-pick today — kept in the call site
  // so future kinds (rubble, scree) can mix it in without a signature change.
  void detail;
  return BOUNDARY_KIND_GRASS_MOUND;
}
