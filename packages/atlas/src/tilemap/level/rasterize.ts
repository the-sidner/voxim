/**
 * Rasterizer — turns a LevelDef into the per-pixel buffers tile-server
 * consumes (openMask / heightMap / materials / kindOf).
 *
 * Architectural split (T-214):
 *
 *   LevelDef = the semantic graph (regions, edges, narrative). The
 *     reducer pipeline owns this. It says WHAT exists where, not how
 *     each pixel looks.
 *
 *   RasterizedBuffers = the per-pixel surface. The rasterizer owns
 *     these. It walks LevelDef + pipeline scratch state and stamps
 *     each pixel.
 *
 * Today's split: openMask is derived purely from LevelDef regions (a
 * path-region pixel is open, everything else is closed). heightMap /
 * materials / kindOf still come from the legacy pipeline stages —
 * those stages produce per-pixel rendering values that aren't yet
 * encoded on regions (biome-modulated floor heights, etc.). As region
 * metadata grows (region.floorMaterial, region.floorHeight, …), more
 * buffers move from "legacy scratch" to "rasterizer-derived."
 *
 * `verifyLevelInvariants` runs inside the rasterizer because the
 * invariants are about the LevelDef ↔ buffers contract — and the
 * rasterizer is the place that owns that contract end-to-end.
 */

import type { PoiNetworkState } from "../pipeline/state.ts";
import type { LevelDef, PlateauRegion } from "./types.ts";
import { levelToZoneOf } from "./types.ts";
import { verifyLevelInvariants } from "./verify.ts";
import {
  BOUNDARY_KIND_STONE, BOUNDARY_KIND_FOREST,
  BOUNDARY_KIND_WATER, BOUNDARY_KIND_GRASS_MOUND,
} from "../pipeline/boundary_kinds.ts";

/**
 * The canonical per-tile rasterized buffer set. All buffers are
 * `gridSize²` row-major. Tile-server reads these via the existing
 * `upsampleTile` path; downstream consumers never receive `zoneOf`
 * directly — it's derived from `level.regions[].pixels` on demand.
 */
export interface RasterizedBuffers {
  openMask:  Uint8Array;
  heightMap: Float32Array;
  materials: Uint16Array;
  kindOf:    Uint16Array;
}

/**
 * Run the rasterizer over the final pipeline state.
 *
 * Produces:
 *   - `openMask` from LevelDef (path-region pixels are open; everything
 *     else is closed by default). Matches the legacy pipeline's
 *     openMask byte-for-byte today; once it diverges, the rasterizer
 *     is the truth.
 *   - `heightMap` / `materials` / `kindOf` passthrough from the legacy
 *     pipeline stages until they migrate onto regions.
 *
 * Verifies the LevelDef contract before sealing — throws if a reducer
 * leaked (e.g. opened a plateau pixel without a stair).
 */
export function rasterize(state: PoiNetworkState): RasterizedBuffers {
  const derivedZoneOf = levelToZoneOf(state.level);
  verifyLevelInvariants(state.level, state.openMask, derivedZoneOf, state.gridSize);
  return {
    openMask:  computeOpenMask(state.level),
    heightMap: state.heightMap,
    materials: state.materials,
    kindOf:    computeKindOf(state.level),
  };
}

/**
 * Compute the `gridSize²` openMask from LevelDef regions. A pixel is
 * open (1) iff a path region owns it; plateau regions and un-zoned
 * pixels stay closed (0).
 */
function computeOpenMask(level: LevelDef): Uint8Array {
  const out = new Uint8Array(level.gridSize * level.gridSize); // zero-init → closed
  for (const r of level.regions) {
    if (r.kind !== "path") continue;
    for (const idx of r.pixels) out[idx] = 1;
  }
  return out;
}

/**
 * Compute the `gridSize²` kindOf from LevelDef regions. Path pixels
 * are BOUNDARY_KIND_OPEN; plateau pixels carry their region's
 * `wallKind`. Un-zoned pixels default to OPEN.
 */
function computeKindOf(level: LevelDef): Uint16Array {
  const out = new Uint16Array(level.gridSize * level.gridSize); // zero-init → OPEN
  for (const r of level.regions) {
    if (r.kind !== "plateau") continue;
    const kindNum = wallKindToBoundary(r);
    for (const idx of r.pixels) out[idx] = kindNum;
  }
  return out;
}

function wallKindToBoundary(r: PlateauRegion): number {
  switch (r.wallKind) {
    case "stone":  return BOUNDARY_KIND_STONE;
    case "forest": return BOUNDARY_KIND_FOREST;
    case "grass":  return BOUNDARY_KIND_GRASS_MOUND;
    case "water":  return BOUNDARY_KIND_WATER;
  }
}

/**
 * Re-export for callers that want the LevelDef type alongside the
 * buffers. Keeps the rasterize module the single import for both.
 */
export type { LevelDef };
