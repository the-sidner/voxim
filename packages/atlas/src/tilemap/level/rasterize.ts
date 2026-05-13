/**
 * Rasterizer — turns a LevelDef into the per-pixel buffers tile-server
 * consumes (heightMap / materials / openMask / kindOf).
 *
 * What this file is *today* (T-214 step 3): a thin typed contract.
 * The legacy pipeline stages still produce the buffers as a side
 * effect; this function packages them and runs the invariant
 * verifier. Pulling the rasterizer interface forward gives downstream
 * commits a single place to migrate buffer production into.
 *
 * What this file becomes (future commits): a pure function
 * `rasterize(level) → buffers`. Regions own their pixels and their
 * renderable properties (wallStep, wallKind, floorMaterial, …); the
 * rasterizer walks regions and stamps the buffers accordingly. The
 * pipeline stages then no longer produce buffers as a side effect —
 * they only mutate LevelDef.
 *
 * The verifier (`verifyLevelInvariants`) lives here too because it
 * checks the LevelDef ↔ buffers contract that the rasterizer is
 * eventually going to own end-to-end.
 */

import type { PoiNetworkState } from "../pipeline/state.ts";
import type { LevelDef } from "./types.ts";
import { levelToZoneOf } from "./types.ts";
import { verifyLevelInvariants } from "./verify.ts";

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
 * Today this is a passthrough that returns the buffers the legacy
 * stages produced, after asserting LevelDef invariants. The contract
 * is the same as the future "compute from LevelDef" form: given a
 * tile's final state, produce the per-pixel buffers consistent with
 * `state.level`.
 */
export function rasterize(state: PoiNetworkState): RasterizedBuffers {
  // Verify the LevelDef contract before sealing the buffers. The
  // verifier needs a zoneOf for the plateau-sealed check; derive it
  // from regions now (when buffers move into the rasterizer, the
  // verifier will take the synthesized buffers as input instead).
  const derivedZoneOf = levelToZoneOf(state.level);
  verifyLevelInvariants(state.level, state.openMask, derivedZoneOf, state.gridSize);
  return {
    openMask:  state.openMask,
    heightMap: state.heightMap,
    materials: state.materials,
    kindOf:    state.kindOf,
  };
}

/**
 * Re-export for callers that want the LevelDef type alongside the
 * buffers. Keeps the rasterize module the single import for both.
 */
export type { LevelDef };
