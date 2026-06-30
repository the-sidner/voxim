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
import { zoneGraph } from "./pipeline/zone_graph.ts";
import { poiNetwork } from "./pipeline/poi_network.ts";
import { fieldsStage } from "./pipeline/fields.ts";
import { deriveGateSummary } from "./summary.ts";
import { emptyLevel } from "./level/types.ts";
import { rasterize } from "./level/rasterize.ts";
import type { TileInit, TileInitWire } from "./types.ts";
import type { WorldCellRecord } from "../worldmap/types.ts";
import { DEFAULT_GEN_PARAMS, type GenParams } from "../genparams.ts";
import type { PipelineBase, FieldsState } from "./pipeline/state.ts";
import type { ContentService } from "@voxim/content";

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
  /**
   * Optional content store. When provided, the POI-network stage (T-209)
   * runs the matcher against `content.pois.values()` and emits a populated
   * narrative; when absent, narrative is empty. Tests + worldgen sanity
   * checks that don't care about POIs can omit it.
   */
  content?: ContentService;
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

  const initial: PipelineBase = {
    worldCell, tileSize, gridSize, px2world,
    content: options.content,
    level: emptyLevel({
      gridSize, tileSize, seed: tileSeed,
      cellX: worldCell.cellX, cellY: worldCell.cellY,
    }),
  };

  const pipeline: Stage<PipelineBase, FieldsState> = pipe(
    bind(noiseField,      params.noise,      tileSeed),
    bind(junctions,       params.room,       tileSeed),
    bind(network,         params.network,    tileSeed),
    bind(rooms,           params.room,       tileSeed),
    bind(portalPlacement, params.network,    tileSeed),
    bind(boundaryKinds,   params.kinds,      tileSeed),
    bind(rivers,          params.river,      tileSeed),
    bind(terrain,         params.terrain,    tileSeed),
    bind(materials,       params.materials,  tileSeed),
    bind(zoneGraph,       params.zoneGraph,  tileSeed),
    bind(poiNetwork,      params.poiNetwork, tileSeed),
    bind(fieldsStage,     params.fields,     tileSeed),
  );

  const s = pipeline(initial);

  // T-214: rasterize the LevelDef into the per-pixel buffers tile-
  // server consumes. Today the function is a passthrough that returns
  // the buffers the pipeline stages produced + runs the invariant
  // verifier; future commits move buffer production into it.
  const buffers = rasterize(s);

  return {
    cellX:    worldCell.cellX,
    cellY:    worldCell.cellY,
    tileSize,
    gridSize,
    openMask:   buffers.openMask,
    roomOf:     s.roomOf,
    rooms:      s.rooms,
    chamberOf:  s.chamberOf,
    chambers:   s.chambers,
    corridors:  s.corridors,
    portals:    s.portals,
    gateSummary: deriveGateSummary(s.portals),
    heightMap:  buffers.heightMap,
    materials:  buffers.materials,
    kindOf:     buffers.kindOf,
    // state.level was seeded by emptyLevel() and progressively built
    // by the reducer stages (zoneGraph: regions + portals;
    // poiNetwork: narrative + stairs). Regions carry their pixel
    // sets; the derived `zoneOf` index can be recovered via
    // `levelToZoneOf(level)` on the consumer side.
    level:      s.level,
    fields:     s.fields,
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
    level:     t.level,
    fieldsB64: encodeFieldsB64(t.fields),
    boundaries: t.boundaries,
    features:   t.features,
  };
}

/** Encode the render-field planes to a name→base64 map (T-311 P3). */
function encodeFieldsB64(f: TileInit["fields"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    out[k] = bytesToBase64(new Uint8Array((v as ArrayBufferView).buffer, (v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteLength));
  }
  return out;
}

/** Decode the name→base64 field map back into typed planes (u8, f32 surfaceLevel).
 *  Absent map (a world baked before T-311 P3) → neutral zero/NaN planes of
 *  gridSize² so an old DB payload loads without crashing; a re-bake fills them. */
function decodeFieldsB64(m: Record<string, string> | undefined, cells: number): TileInit["fields"] {
  if (!m) {
    const z = () => new Uint8Array(cells);
    return {
      canopyLight: z(), corruption: z(), fertility: z(),
      wetness: z(), overgrowth: z(), wear: z(),
      variantIndex: z(), ruinAge: z(), traffic: z(),
      surfaceLevel: new Float32Array(cells).fill(NaN),
    };
  }
  const u8 = (k: string) => base64ToBytes(m[k]);
  const f32 = (k: string) => { const b = base64ToBytes(m[k]); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
  return {
    canopyLight: u8("canopyLight"), corruption: u8("corruption"), fertility: u8("fertility"),
    wetness: u8("wetness"), overgrowth: u8("overgrowth"), wear: u8("wear"),
    variantIndex: u8("variantIndex"), ruinAge: u8("ruinAge"), traffic: u8("traffic"),
    surfaceLevel: f32("surfaceLevel"),
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
  // (fields decoded below in the return via decodeFieldsB64)
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
    level:     w.level,
    fields:    decodeFieldsB64(w.fieldsB64, w.gridSize * w.gridSize),
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
