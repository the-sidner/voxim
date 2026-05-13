/**
 * Accumulating state for the tilemap pipeline.
 *
 * Each stage takes the prior state, runs its work, and returns the prior
 * state plus its produced fields. The types here name that progression
 * explicitly: `NoiseState` is what exists after `noiseField` runs;
 * `JunctionsState extends NoiseState` is what exists after `junctions`
 * runs; and so on. Reordering stages is a compile error because the
 * `pipe()` overload requires successive `TOut → TIn` matches.
 *
 * The transformer pattern (@voxim/levelgen) gives each stage:
 *   `Transformer<PrevState, NextState, Params>`
 * which is `(state, seed, params) => newState`.
 *
 * Seed strategy in this migration: every stage receives `tileSeed`
 * verbatim and continues to combine it internally with its own
 * `SUB_SEED` constant — byte-identical with the pre-T-204 pipeline.
 * Migrating to `splitSeed()` is deliberate behaviour change and lives
 * in a follow-up ticket.
 */

import type { WorldCellRecord } from "../../worldmap/types.ts";
import type { Junction } from "./junctions.ts";
import type { Corridor, Portal, Room } from "../types.ts";
import type { ContentService, ZoneRole } from "@voxim/content";

export interface PipelineBase {
  worldCell: WorldCellRecord;
  tileSize: number;
  gridSize: number;
  px2world: number;
  /**
   * Optional content store — required by the Tier-6 POI network stage
   * (T-209) to look up POI definitions. Other stages ignore it. When
   * absent, the POI stage emits an empty narrative so the rest of the
   * pipeline stays deterministic and snapshot-stable.
   */
  content?: ContentService;
}

export interface NoiseState extends PipelineBase {
  noiseField: Float32Array;
}

export interface JunctionsState extends NoiseState {
  seeds: Junction[];
}

export interface NetworkState extends JunctionsState {
  /** Mutated by network/rooms/portals/rivers stages. */
  openMask: Uint8Array;
  corridors: Corridor[];
  degrees: Uint8Array;
}

export interface RoomsState extends NetworkState {
  chamberOf: Uint16Array;
  chambers: Room[];
}

export interface PortalsState extends RoomsState {
  rooms: Room[];
  roomOf: Uint16Array;
  portals: Portal[];
}

export interface KindsState extends PortalsState {
  kindOf: Uint16Array;
}

/**
 * Rivers mutates `openMask` and `kindOf` in place and produces no new
 * fields; the state type is unchanged across this stage but the values
 * inside change.
 */
export type RiversState = KindsState;

export interface TerrainState extends RiversState {
  heightMap: Float32Array;
}

export interface MaterialsState extends TerrainState {
  materials: Uint16Array;
}

/**
 * One zone in the AnnotatedZoneGraph (T-208). A zone is a connected
 * component of open pixels — either a chamber (with a `chamberOf` tag)
 * or a corridor segment (open pixels with no chamber tag, flooded as
 * its own component). Adjacency in the zone graph mirrors which zones
 * physically touch through open pixels.
 *
 * The Tier-6 generator (T-209) consumes this to match POI candidates
 * to zones by `fit.preferredTopology`, `fit.minArea/maxArea`, etc.
 */
export interface AnnotatedZone {
  id: number;
  /** Pixel count of the zone. */
  area: number;
  /** Mean pixel position in grid coords. */
  centroid: { x: number; y: number };
  /** Axis-aligned bounding box in grid coords. */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** min(bbox.w, bbox.h) / max(bbox.w, bbox.h). 1.0 = square; → 0 elongated. */
  aspectRatio: number;
  /**
   * Fraction of the zone's boundary pixels that touch *closed* pixels
   * (vs. other zones). 0.0 = open plaza connected on all sides,
   * 1.0 = fully sealed cave.
   */
  enclosure: number;
  /** Topology role assigned by the rule-based classifier. */
  topologyRole: ZoneRole;
  /**
   * Counts of neighbouring closed-pixel kinds (kindOf values) on this
   * zone's boundary. Used by POI `fit.requiredKind` matching — a zone
   * surrounded by stone walls matches "stone"-requiring POIs.
   */
  kindHistogram: Record<number, number>;
  /** Ids of zones adjacent through open-pixel-to-open-pixel transitions. */
  neighbors: number[];
  /** True if any portal pixel lies inside this zone (gate entry zone). */
  isEntry: boolean;
  /** True for corridor-derived zones; false for chamber-derived zones. */
  isCorridor: boolean;
}

/** Sentinel for `zoneOf` — closed pixels and any non-tracked open pixels. */
export const ZONE_ID_NONE = 0xFFFF;

export interface AnnotatedZoneState extends MaterialsState {
  /** Per-pixel zone id; 0xFFFF for closed pixels. Length = gridSize². */
  zoneOf: Uint16Array;
  /** Indexed by zone id; gaps are possible if some ids were skipped. */
  zones: AnnotatedZone[];
}

// ---- Tier 6 — POI network + dependency-DAG (T-209) -----------------

export type DagShape = "linear" | "branching" | "diamond" | "lattice";

/** Trinket — the edge token in the dependency DAG. */
export interface TrinketInstance {
  id: string;
  /** PoiInstance id that drops this trinket on completion. */
  sourcePoi: string;
  /** PoiInstance id whose gate this trinket unlocks. */
  destPoi: string;
  /** Themes the trinket carries — intersection of source themes and dest accept. */
  themes: string[];
  /** Procedural display name, e.g. "Bone of the Savage Wolf Den". */
  displayName: string;
}

/**
 * Resolved gate — for `item`/`multi`/`choice` kinds, `trinketRefs` holds the
 * specific trinket ids the destination POI requires. Empty for `open` gates.
 */
export interface ResolvedGate {
  kind: "open" | "item" | "multi" | "choice";
  trinketRefs: string[];
}

/** Bound POI in a tile — content def reference + spatial anchor + gate. */
export interface PoiInstance {
  id: string;
  /** POI definition id (refs `packages/content/data/pois/{id}.json`). */
  poiDefId: string;
  /** Zone in the AnnotatedZoneGraph this POI occupies. */
  zoneId: number;
  /** Gate after wiring; trinketRefs is populated for non-open gates. */
  gate: ResolvedGate;
  /** Trinket this POI drops on completion (null if it's a terminal with no downstream). */
  trinketId: string | null;
}

/**
 * Tile-level narrative artifact — POIs placed, trinkets defined, DAG
 * structure as a derived shape. Output of T-209's transformer.
 */
export interface TileNarrative {
  pois: PoiInstance[];
  trinkets: TrinketInstance[];
  dagShape: DagShape;
  entryPoiIds: string[];
  terminalPoiIds: string[];
  /** True if the matcher fell back to a degraded DAG (retry budget exhausted). */
  degraded: boolean;
  /** Number of solver retries the matcher consumed before settling. */
  retries: number;
}

export interface PoiNetworkState extends AnnotatedZoneState {
  narrative: TileNarrative;
}
