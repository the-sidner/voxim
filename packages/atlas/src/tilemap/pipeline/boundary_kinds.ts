/**
 * Stage 6 — boundary kinds.
 *
 * Every closed cell (openMask = 0) gets a boundary kind id that decides
 * how the cell will eventually render and what player verbs can transform
 * it. Open cells get BOUNDARY_KIND_OPEN.
 *
 * Three wall kinds in active use, all raised by the terrain stage to the
 * same WALL_HEIGHT (2u, just past the runtime stepHeight so none of them
 * are walkable):
 *
 *   STONE       — bare grey rock walls. Picked when the biome is high
 *                 altitude or rugged enough that exposed rock makes sense.
 *   FOREST      — dense vegetation walls; tile-server spawns tree
 *                 entities on top of these cells at runtime so the wall
 *                 reads as "you can't push through this wall of trees."
 *   GRASS_MOUND — green grassy berm; the fallback wall when neither of
 *                 the above qualifies.
 *
 * WATER is a separate non-wall kind set by the river-stamping stage; it
 * stays at floor height and isn't picked from biome (rivers carve it).
 *
 * Selection is rule-based on biome params + per-cell detail noise.
 * Each closed cell asks: "what kind of obstacle am I?" — and the rule
 * leans on the same biome that drove the noise field, so transitions
 * across the cell-grid feel coherent.
 *
 * Pure function: same (openMask, biome, tileSeed) → same kindOf array.
 */

import type { Transformer } from "@voxim/levelgen";
import { fbm } from "@voxim/levelgen";
import { BoundaryKind } from "@voxim/protocol";
import type { KindsState, PortalsState } from "./state.ts";
import type { BiomeParams } from "../../worldmap/types.ts";
import type { GenParams } from "../../genparams.ts";

// Boundary-kind ids are @voxim/protocol's `BoundaryKind` (wire
// vocabulary — KindGrid ships these ids on the wire, T-315 C4). Atlas is
// the canonical *producer* of the kindOf array but reads the id values
// from protocol like every other consumer — one owner, no mirrored names.
// 0 (BoundaryKind.open) is reserved for "not a boundary" so a fresh
// Uint16Array reads as un-tagged before this stage runs.

const KIND_SUB_SEED = 0x60006001;

export const boundaryKinds: Transformer<PortalsState, KindsState, GenParams["kinds"]> =
  (state, seed, params) => {
    const { openMask, gridSize, worldCell: { biome } } = state;
    const N = gridSize * gridSize;
    const kindOf = new Uint16Array(N);
    const f = params.detailFrequency;

    for (let py = 0; py < gridSize; py++) {
      for (let px = 0; px < gridSize; px++) {
        const idx = py * gridSize + px;
        if (openMask[idx] === 1) {
          kindOf[idx] = BoundaryKind.open;
          continue;
        }
        const detail = fbm(px * f, py * f, seed ^ KIND_SUB_SEED, 2);
        kindOf[idx] = pickKind(biome, detail, params);
      }
    }

    return { ...state, kindOf };
  };

function pickKind(
  b: BiomeParams,
  detail: number,
  p: GenParams["kinds"],
): number {
  if (b.altitude > p.stoneAltitudeStrict) return BoundaryKind.stone;
  if (b.altitude > p.stoneAltitudeRugged && b.ruggedness > p.stoneRuggednessThreshold) return BoundaryKind.stone;
  if (b.moisture > p.forestMoisture) return BoundaryKind.forest;
  // Detail noise is unused in the wall-pick today — kept in the call site
  // so future kinds (rubble, scree) can mix it in without a signature change.
  void detail;
  return BoundaryKind.grassMound;
}
