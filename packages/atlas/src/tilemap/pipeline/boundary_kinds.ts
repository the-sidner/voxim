/**
 * Stage 6 — boundary kinds.
 *
 * Every closed pixel (openMask = 0) gets a boundary kind id that decides
 * how the pixel will eventually render and what player verbs can transform
 * it. Open pixels get BOUNDARY_KIND_OPEN.
 *
 * Phase 4A scope: tag pixels only. Tile-server's renderer + physics still
 * treat every closed pixel uniformly (raised cliff). Subsequent phases:
 *   4B — openMask flows through to physics so collision is independent
 *        of how the boundary chooses to render.
 *   4C — per-kind rendering in tile-server: vegetation stops raising the
 *        heightmap and spawns tree entities; cliffs keep the +3u step.
 *
 * Selection is rule-based on biome params + per-pixel detail noise.
 * Each closed pixel asks: "what kind of obstacle am I?" — and the rule
 * leans on the same biome that drove the noise field, so transitions
 * across the cell-grid feel coherent (forested cells tend toward
 * vegetation walls, mountainous cells toward cliffs).
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
export const BOUNDARY_KIND_OPEN       = 0;
export const BOUNDARY_KIND_CLIFF      = 1;
export const BOUNDARY_KIND_VEGETATION = 2;
export const BOUNDARY_KIND_WATER      = 3;
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
  if (b.altitude > p.cliffAltitudeStrict) return BOUNDARY_KIND_CLIFF;
  if (b.altitude > p.cliffAltitudeRugged && b.ruggedness > p.cliffRuggednessThreshold) return BOUNDARY_KIND_CLIFF;
  if (b.moisture > p.waterMoisture && b.altitude < p.waterAltitude && detail > p.waterDetail) return BOUNDARY_KIND_WATER;
  if (b.moisture > p.vegetationMoisture) return BOUNDARY_KIND_VEGETATION;
  // Dry, low, sparse — fall back to cliff (rubble/scree slot reserved for later).
  return BOUNDARY_KIND_CLIFF;
}
