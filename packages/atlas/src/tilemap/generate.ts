/**
 * Tilemap orchestrator — runs the per-tile pipeline against one worldmap cell.
 *
 * Pipeline:
 *   1. noiseField       — biome-driven fbm cost surface (Float32Array)
 *   2. junctions        — Poisson-disk seeds (graph nodes only, no rooms)
 *   3. network          — Delaunay + MST + braid + bezier carve seed→seed
 *                         + recursive branches → openMask, corridors[],
 *                         per-junction degrees[]
 *   4. rooms            — per junction, roll roomChance(degree); chosen
 *                         junctions grow noise-flooded disks → chamberOf,
 *                         chambers[]
 *   5. portalPlacement  — bezier-carve gate→nearest-junction → portals[],
 *                         appends to corridors[], re-labels rooms/roomOf
 *   6. boundaryKinds    — per-pixel kind tagging
 *   7. rivers           — overlay water onto openMask + kindOf
 *   8. terrain          — heightmap from openMask + kindOf
 *   9. materials        — per-pixel material id
 *
 * Each stage is a `Transformer<TIn, TOut, TParams>` (@voxim/levelgen).
 * `pipe()` composes them with type-aware narrowing: reordering or
 * dropping a stage is a compile error because the next stage's TIn
 * stops matching the prior TOut.
 *
 * Pure function: same (worldCell, tileSeed, options) always yields the
 * same TileInit.
 */

import { pipe, type Stage, type Transformer } from "@voxim/levelgen";
import { noiseField } from "./pipeline/noise_field.ts";
import { junctions } from "./pipeline/junctions.ts";
import { network } from "./pipeline/network.ts";
import { rooms } from "./pipeline/rooms.ts";
import { portalPlacement } from "./pipeline/portal_placement.ts";
import { boundaryKinds } from "./pipeline/boundary_kinds.ts";
import { rivers } from "./pipeline/rivers.ts";
import { terrain } from "./pipeline/terrain.ts";
import { materials } from "./pipeline/materials.ts";
import { deriveGateSummary } from "./summary.ts";
import type { TileInit, TileInitWire } from "./types.ts";
import type { WorldCellRecord } from "../worldmap/types.ts";
import { DEFAULT_GEN_PARAMS, type GenParams } from "../genparams.ts";
import type { PipelineBase, MaterialsState } from "./pipeline/state.ts";

const DEFAULT_TILE_SIZE = 512;
// One pixel = one world unit = one runtime voxel. Atlas runs the pipeline
// at the same resolution tile-server samples so the inspector view matches
// what the player walks on (no upsample seam).
const DEFAULT_GRID_SIZE = 512;

export interface GenerateTileOptions {
  /** Side length of the playable tile in world units. Default 512. */
  tileSize?: number;
  /** Sample-grid resolution. Default 128 → 4 world units per pixel. */
  gridSize?: number;
  /** Worldgen tuning. Defaults from DEFAULT_GEN_PARAMS. */
  params?: GenParams;
}

/**
 * Local binding helper. Each stage's transformer receives `tileSeed`
 * verbatim and continues to combine it internally with its own
 * `SUB_SEED` constant — byte-identical with the pre-T-204 pipeline.
 * Migrating to `splitSeed(tileSeed, stageId)` (which would reroll every
 * stage's RNG stream) is deliberate behaviour change and lives in a
 * follow-up ticket. `bindStage()` from `@voxim/levelgen` is therefore
 * not used here; this local `bind` passes `tileSeed` straight through.
 */
function bind<TIn, TOut, TParams>(
  t: Transformer<TIn, TOut, TParams>,
  params: TParams,
  seed: number,
): Stage<TIn, TOut> {
  return (state) => t(state, seed, params);
}

export function generateTile(
  worldCell: WorldCellRecord,
  tileSeed: number,
  options: GenerateTileOptions = {},
): TileInit {
  const tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
  const gridSize = options.gridSize ?? DEFAULT_GRID_SIZE;
  const params   = options.params   ?? DEFAULT_GEN_PARAMS;
  const px2world = tileSize / gridSize;

  const initial: PipelineBase = { worldCell, tileSize, gridSize, px2world };

  const pipeline: Stage<PipelineBase, MaterialsState> = pipe(
    bind(noiseField,      params.noise,     tileSeed),
    bind(junctions,       params.room,      tileSeed),
    bind(network,         params.network,   tileSeed),
    bind(rooms,           params.room,      tileSeed),
    bind(portalPlacement, params.network,   tileSeed),
    bind(boundaryKinds,   params.kinds,     tileSeed),
    bind(rivers,          params.river,     tileSeed),
    bind(terrain,         params.terrain,   tileSeed),
    bind(materials,       params.materials, tileSeed),
  );

  const s = pipeline(initial);

  return {
    cellX:    worldCell.cellX,
    cellY:    worldCell.cellY,
    tileSize,
    gridSize,
    openMask:   s.openMask,
    roomOf:     s.roomOf,
    rooms:      s.rooms,
    chamberOf:  s.chamberOf,
    chambers:   s.chambers,
    corridors:  s.corridors,
    portals:    s.portals,
    gateSummary: deriveGateSummary(s.portals),
    heightMap:  s.heightMap,
    materials:  s.materials,
    kindOf:     s.kindOf,
    boundaries: [],
    features:   [],
  };
}


// ---- wire encoding --------------------------------------------------------

export function tileInitToWire(t: TileInit): TileInitWire {
  return {
    cellX:    t.cellX,
    cellY:    t.cellY,
    tileSize: t.tileSize,
    gridSize: t.gridSize,
    openMaskB64:   bytesToBase64(t.openMask),
    roomOfB64:     bytesToBase64(new Uint8Array(t.roomOf.buffer,    t.roomOf.byteOffset,    t.roomOf.byteLength)),
    chamberOfB64:  bytesToBase64(new Uint8Array(t.chamberOf.buffer, t.chamberOf.byteOffset, t.chamberOf.byteLength)),
    heightMapB64:  bytesToBase64(new Uint8Array(t.heightMap.buffer, t.heightMap.byteOffset, t.heightMap.byteLength)),
    materialsB64:  bytesToBase64(new Uint8Array(t.materials.buffer, t.materials.byteOffset, t.materials.byteLength)),
    kindOfB64:     bytesToBase64(new Uint8Array(t.kindOf.buffer,    t.kindOf.byteOffset,    t.kindOf.byteLength)),
    rooms:    t.rooms,
    chambers: t.chambers,
    corridors: t.corridors,
    portals:  t.portals,
    gateSummary: t.gateSummary,
    boundaries: t.boundaries,
    features:   t.features,
  };
}

export function tileInitFromWire(w: TileInitWire): TileInit {
  const openMask = base64ToBytes(w.openMaskB64);
  const roomOfBytes = base64ToBytes(w.roomOfB64);
  const roomOf = new Uint16Array(
    roomOfBytes.buffer,
    roomOfBytes.byteOffset,
    roomOfBytes.byteLength / 2,
  );
  const chamberOfBytes = base64ToBytes(w.chamberOfB64);
  const chamberOf = new Uint16Array(
    chamberOfBytes.buffer,
    chamberOfBytes.byteOffset,
    chamberOfBytes.byteLength / 2,
  );
  const heightBytes = base64ToBytes(w.heightMapB64);
  const heightMap = new Float32Array(
    heightBytes.buffer,
    heightBytes.byteOffset,
    heightBytes.byteLength / 4,
  );
  const matBytes = base64ToBytes(w.materialsB64);
  const materials = new Uint16Array(
    matBytes.buffer,
    matBytes.byteOffset,
    matBytes.byteLength / 2,
  );
  const kindBytes = base64ToBytes(w.kindOfB64);
  const kindOf = new Uint16Array(
    kindBytes.buffer,
    kindBytes.byteOffset,
    kindBytes.byteLength / 2,
  );
  return {
    cellX:    w.cellX,
    cellY:    w.cellY,
    tileSize: w.tileSize,
    gridSize: w.gridSize,
    openMask,
    roomOf,
    chamberOf,
    heightMap,
    materials,
    kindOf,
    rooms:    w.rooms,
    chambers: w.chambers,
    corridors: w.corridors,
    portals:  w.portals,
    gateSummary: w.gateSummary,
    boundaries: w.boundaries,
    features:   w.features,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid blowing the call stack on String.fromCharCode.apply.
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof b64 !== "string") {
    throw new Error(
      `tile-init wire decode: expected base64 string, got ${b64 === undefined ? "undefined" : typeof b64}; ` +
      `payload likely missing a field (atlas/tile-server image mismatch?)`,
    );
  }
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
