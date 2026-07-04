/**
 * Stage — terraced-cliff derivation (T-311 Phase 6). Resolves stone
 * wilderness-perimeter cells into a `CliffGrid` {profileId, erosion, tier,
 * edge} bundle for the client `cliffVoxeliser` registry, using the SAME
 * content-lookup idiom `poiNetwork` uses for `state.content` (optional;
 * absent → an all-zero CliffPlanes so snapshot tests without content stay
 * deterministic).
 *
 * v1 scope (T-318): only `BoundaryKind.stone` cells get a profile — forest/
 * grassMound/water walls stay `profileId = 0` ("none"), matching the
 * pre-P6 client behaviour's absence for those kinds once the CLIFF_* trigger
 * heuristics retire (a real scope narrowing vs. today's ANY-material
 * depth-based stacking; see T-318's ticket body). `tier` on the emitted
 * grid is NOT the authority for stack height — the resolved profile's
 * `tierCount` is; `tier` is reserved for a future per-cell-depth read.
 * `Heightmap` is left byte-identical to the pre-P6 single-`wallStep` output:
 * v1 terracing is vertical coursing within one wall cell's column (the
 * client voxeliser's job), not a horizontal multi-ring staircase — see
 * T-318 for the full reasoning. Placed after `zoneGraph` (needs nothing
 * from it directly today, but sits next to the region/wallKind machinery)
 * and before `poiNetwork`/`fields` in the stage order.
 */
import type { Transformer } from "@voxim/levelgen";
import { BoundaryKind } from "@voxim/protocol";
import type { CliffProfileDef } from "@voxim/content";
import type { AnnotatedZoneState, CliffState } from "./state.ts";

/** Deterministic 0..255 hash of two integers (mirrors fields.ts's hash255). */
function hash255(a: number, b: number): number {
  let n = (Math.imul(a, 374761393) ^ Math.imul(b, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) & 0xff;
}

export interface CliffPlanes {
  profileId: Uint8Array;
  erosion: Uint8Array;
  tier: Uint8Array;
  edge: Uint8Array;
}

export interface CliffDeriveInput {
  gridSize: number;
  /** BOUNDARY_KIND_* per cell, length gridSize². */
  kindOf: Uint16Array;
  /** 1 = open, 0 = closed, length gridSize². */
  openMask: Uint8Array;
  /** Chamber id per cell (0 = no chamber) — the per-zone erosion hash key. */
  chamberOf: Uint16Array;
  /** Tile seed for the deterministic erosion-state hash. */
  tileSeed: number;
  /** Stable alphabetical id→index table (index 0 reserved = "no cliff here";
   *  profile ids start at 1) — SAME order client_world's cliffVoxeliser
   *  dispatch must build, mirroring JsonSource's own alphabetical load
   *  order (I3c). Empty when no content store is available. */
  profileIndex: ReadonlyArray<CliffProfileDef>;
  params: CliffParams;
}

export interface CliffParams {
  erosionCrispMax: number;
  erosionWeatheredMax: number;
}

/** Pure `signals → 4 per-cell planes` core. No pipeline coupling — testable
 *  in isolation, mirrors `deriveFieldPlanes`. */
export function deriveCliffPlanes(input: CliffDeriveInput): CliffPlanes {
  const { gridSize, kindOf, openMask, chamberOf, tileSeed, profileIndex, params } = input;
  const n = gridSize * gridSize;

  const profileId = new Uint8Array(n);
  const erosion = new Uint8Array(n);
  const tier = new Uint8Array(n);
  const edge = new Uint8Array(n);

  if (profileIndex.length === 0) {
    // No content store (unit tests / a content-less pipeline run) — an
    // all-zero grid mirrors poiNetwork's "no-op without content" stance.
    return { profileId, erosion, tier, edge };
  }

  // First registered profile is the v1 default look for every stone wall
  // cell (content authors more variety later; nothing today resolves a
  // PER-CELL profile choice beyond erosion state).
  const defaultProfileIdx = 1; // profileIndex[0] → wire index 1 (0 = "none")

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const i = x + y * gridSize;
      if (openMask[i] !== 0) continue;           // open cells never get a profile
      if (kindOf[i] !== BoundaryKind.stone) continue; // v1 scope: stone walls only

      // edge: this closed stone cell touches an open neighbour (the outward
      // lip the client stacks) — buried interior wall cells stay edge=0.
      const nOpen =
        (x > 0 && openMask[i - 1] !== 0) ||
        (x < gridSize - 1 && openMask[i + 1] !== 0) ||
        (y > 0 && openMask[i - gridSize] !== 0) ||
        (y < gridSize - 1 && openMask[i + gridSize] !== 0);
      if (!nOpen) continue; // buried cell: leave profileId 0 (nothing to stack)

      edge[i] = 1;
      profileId[i] = defaultProfileIdx;

      // erosion: one deterministic hash per chamber (or per-cell if this
      // wall borders no chamber) so a whole plateau edge reads as one
      // weathered look, not per-cell noise.
      const key = chamberOf[i] !== 0 ? chamberOf[i] : (i + 1);
      const h = hash255(key, tileSeed);
      erosion[i] = h < params.erosionCrispMax ? 0 : h < params.erosionWeatheredMax ? 1 : 2;

      // tier: v1 redundant with the profile's fixed tierCount (see module
      // doc) — kept at 0 (top course) as the reserved per-cell-depth slot.
      tier[i] = 0;
    }
  }

  return { profileId, erosion, tier, edge };
}

// ---- pipeline stage --------------------------------------------------------

export const cliffStage: Transformer<AnnotatedZoneState, CliffState, CliffParams> =
  (state, seed, params) => {
    const profileIndex = state.content
      ? [...state.content.cliffProfiles.values()].sort((a, b) => a.id.localeCompare(b.id))
      : [];
    const cliff = deriveCliffPlanes({
      gridSize: state.gridSize,
      kindOf: state.kindOf,
      openMask: state.openMask,
      chamberOf: state.chamberOf,
      tileSeed: seed,
      profileIndex,
      params,
    });
    return { ...state, cliff };
  };
