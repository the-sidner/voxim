/**
 * LevelDef — the authoritative semantic structure of a tile (T-214).
 *
 * The pipeline mutates a `LevelDef` through a chain of reducers; a
 * separate algorithm (step 9) rasterizes it into the pixel buffers
 * tile-server consumes for rendering and physics.
 *
 *   reducer(state, level, seed, params)  → mutates state.level
 *   rasterize(level)                     → openMask / heightMap / materials / …
 *
 * Today: each pipeline stage that produces semantic output writes its
 * slice onto `state.level` directly. `zoneGraph` writes regions + portal
 * edges; `poiNetwork` writes narrative + stair edges. The remaining
 * legacy pipeline stages still produce per-pixel buffers as a side
 * effect; step 9 of the migration moves that final piece into a
 * dedicated rasterizer.
 *
 * Wire shape: this type is JSON-friendly (no typed arrays, no buffer
 * pointers). Regions reference their pixels via `zoneId`, which indexes
 * the existing `zoneOf` buffer on the same TileInit. Once reducers own
 * shape directly (post step 9), regions will carry their own mask data.
 */

import type { DagShape } from "../pipeline/state.ts";
import type { ZoneRole } from "@voxim/content";

/** Stable, region-kind-tagged id. Format examples: `chamber:c3`, `plateau:p7`. */
export type RegionId = string;

export interface BBox {
  minX: number; minY: number; maxX: number; maxY: number;
}

export interface Point {
  x: number; y: number;
}

/**
 * Common metadata for every region. The region owns its pixel set
 * via `pixels` — a sorted array of flat indices into the gridSize²
 * grid (`idx = y * gridSize + x`). Together the regions' pixels
 * partition the grid (every non-out-of-bounds pixel belongs to at
 * most one region; un-zoned pixels — e.g. OPEN-kind sentinels — don't
 * appear in any region's list).
 *
 * `zoneId` is a stable numeric id used as the value of a derived
 * `zoneOf` index when one is needed for fast O(1) "which region is at
 * pixel P?" lookups. Tile-server builds that derived index at boot via
 * `levelToZoneOf(level, gridSize)`.
 */
export interface RegionMeta {
  id: RegionId;
  zoneId: number;
  area: number;
  centroid: Point;
  bbox: BBox;
  /** Sorted flat pixel indices (idx = y * gridSize + x). length === area. */
  pixels: number[];
  /** Procedural display name, e.g. "Whispering Grove". Empty when sub-threshold. */
  name: string;
}

/** A bounded path-floor region — chambers, plazas, junctions. */
export interface PathRegion extends RegionMeta {
  kind: "path";
  /** Topology role assigned by the classifier (chamber/plaza/arena/crossroads/…). */
  topologyRole: ZoneRole;
  /** True if any tile-edge gate lives in this region. */
  isEntry: boolean;
}

/**
 * A raised wilderness blob — closed pixels with floor at `topHeight`,
 * unreachable from path-level except via a `StairEdge`. The gameplay
 * contract: `jumpable === false` means physics blocks any vertical
 * traversal of the perimeter, regardless of `wallStep`. The rasterizer
 * is responsible for tagging the perimeter pixels accordingly.
 */
export interface PlateauRegion extends RegionMeta {
  kind: "plateau";
  topologyRole: ZoneRole;
  /** Visual wall material at the perimeter. */
  wallKind: "stone" | "forest" | "grass" | "water";
  /** Plateau floor elevation above the surrounding path floor. */
  wallStep: number;
  /** True (always). Encoded explicitly so future "hop-over" variants can override. */
  jumpable: false;
}

/** A river surface — not walkable on land terms. */
export interface RiverRegion extends RegionMeta {
  kind: "river";
}

export type Region = PathRegion | PlateauRegion | RiverRegion;

// ---- Edges between regions ----------------------------------------------

/**
 * Gated vertical transition between a path region and a plateau. The
 * anchor pixel sits on the path side; the climb direction points into
 * the plateau. `locked` carries the trinket reference when the stair
 * is part of a quest gate; `null` for "found" stairs (open at boot).
 */
export interface StairEdge {
  id: string;
  from: RegionId;            // path-side
  to: RegionId;              // plateau-side
  anchorPixel: Point;
  climbDir: { dx: number; dy: number };
  rampDepth: number;
  rampHalfWidth: number;
  locked: { trinketId: string } | null;
}

/** A tile-edge gate to a neighbouring tile. */
export interface PortalEdge {
  id: string;
  hostRegion: RegionId;
  edge: "north" | "east" | "south" | "west";
  /** Pixel along the tile edge (one of x or y is fixed to 0 / gridSize-1). */
  pixel: Point;
}

// ---- Narrative overlay --------------------------------------------------

export interface PoiPlacement {
  id: string;
  poiDefId: string;
  hostRegion: RegionId;
  gate: { kind: "open" | "item" | "multi" | "choice"; trinketRefs: string[] };
  /** Trinket dropped on completion (null for terminal POIs with no downstream). */
  dropsTrinket: string | null;
  /** Stair edge id when this POI sits on a plateau gated by a stair. */
  stairEdge: string | null;
}

export interface TrinketEdge {
  id: string;
  sourcePoi: string;
  destPoi: string;
  themes: string[];
  displayName: string;
}

export interface NarrativeDag {
  shape: DagShape;
  entryPoiIds: string[];
  terminalPoiIds: string[];
  degraded: boolean;
  retries: number;
}

// ---- Top-level shape ----------------------------------------------------

export interface LevelDef {
  gridSize: number;
  tileSize: number;
  seed: number;
  cellX: number;
  cellY: number;

  regions: Region[];

  edges: {
    stairs: StairEdge[];
    portals: PortalEdge[];
  };

  narrative: {
    pois: PoiPlacement[];
    trinkets: TrinketEdge[];
    dag: NarrativeDag;
  };
}

// ---- Reducer signature --------------------------------------------------

/**
 * A stage of the LevelDef pipeline. Mutates `level` in place and returns
 * void. Params are stage-specific (the same `GenParams` slices the
 * legacy pipeline uses). `seed` is the tile seed; reducers combine it
 * with their own sub-seed internally for deterministic streams.
 */
export type Reducer<P> = (level: LevelDef, seed: number, params: P) => void;

// ---- Lookup helpers (cheap, no caching) --------------------------------

export function findRegion(level: LevelDef, id: RegionId): Region | undefined {
  for (const r of level.regions) if (r.id === id) return r;
  return undefined;
}

export function findRegionByZoneId(level: LevelDef, zoneId: number): Region | undefined {
  for (const r of level.regions) if (r.zoneId === zoneId) return r;
  return undefined;
}

/**
 * Build the derived `zoneOf` index from regions' pixel sets. The
 * resulting `Uint16Array` answers "which region owns pixel P?" in
 * O(1). Un-zoned pixels (e.g. OPEN sentinels not claimed by any
 * region) carry the `0xFFFF` sentinel. Pure function — no caching.
 *
 * Use this on the consumer side (tile-server boot, inspector
 * rendering) when you need a per-pixel index. The LevelDef itself
 * doesn't ship zoneOf on the wire — it's recoverable from
 * `regions[].pixels`.
 */
export function levelToZoneOf(level: LevelDef): Uint16Array {
  const out = new Uint16Array(level.gridSize * level.gridSize).fill(0xFFFF);
  for (const r of level.regions) {
    const z = r.zoneId;
    for (const idx of r.pixels) out[idx] = z;
  }
  return out;
}

/**
 * Construct an empty LevelDef for a tile. Threaded onto `PipelineBase`
 * at the start of `generateTile`; each reducer mutates its slice as the
 * pipeline progresses.
 */
export function emptyLevel(opts: {
  gridSize: number;
  tileSize: number;
  seed: number;
  cellX: number;
  cellY: number;
}): LevelDef {
  return {
    gridSize: opts.gridSize,
    tileSize: opts.tileSize,
    seed: opts.seed,
    cellX: opts.cellX,
    cellY: opts.cellY,
    regions: [],
    edges: { stairs: [], portals: [] },
    narrative: {
      pois: [],
      trinkets: [],
      dag: {
        shape: "linear",
        entryPoiIds: [],
        terminalPoiIds: [],
        degraded: false,
        retries: 0,
      },
    },
  };
}
