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
import type { LevelDef } from "../level/types.ts";

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
  /**
   * LevelDef-in-progress (T-214). Starts empty in `generateTile` and is
   * mutated by stages as they compute their slice — `zoneGraph` writes
   * regions + portal edges, `poiNetwork` writes narrative + stair
   * edges, etc. The final `state.level` IS the tile's LevelDef; no
   * post-pass absorber needed. The inspector snapshots this per stage
   * to power layered overlays.
   */
  level: LevelDef;
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
   * Fraction of the zone's boundary pixels that touch the *opposite*
   * traversal class (path zones touch closed pixels; wilderness zones
   * touch open pixels). 0.0 = highly accessible; 1.0 = fully surrounded
   * by the opposite class.
   */
  enclosure: number;
  /** Topology role assigned by the rule-based classifier. */
  topologyRole: ZoneRole;
  /**
   * Counts of in-zone kindOf values (T-210). For path zones this is the
   * histogram of neighbouring closed pixels — what kind of walls
   * surround me. For wilderness zones this is the histogram of the
   * zone's own pixels — what is this plateau made of.
   */
  kindHistogram: Record<number, number>;
  /**
   * Ids of zones adjacent through any boundary transition.
   * Path↔Path: open-pixel-to-open-pixel.
   * Path↔Wilderness: open-pixel-to-closed-pixel.
   * Wilderness↔Wilderness: never adjacent (always separated by path).
   */
  neighbors: number[];
  /** True if any portal pixel lies inside this zone (gate entry zone). */
  isEntry: boolean;
  /** True for corridor-derived path zones; false otherwise. */
  isCorridor: boolean;
  /**
   * Zone class (T-210). `"path"` = default-walkable (open pixels);
   * `"wilderness"` = elevated plateau (closed-pixel blob, reached via
   * a stair-gated ascent).
   */
  traversal: "path" | "wilderness";
  /**
   * Procedural display name (T-211), e.g. "Whispering Grove",
   * "Bandit's Crossroads". Empty string for sub-threshold zones
   * (area < NAMED_AREA_MIN) that don't warrant UI display.
   */
  name: string;
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
  /**
   * For POIs that live on a wilderness zone (T-210): the stair that
   * grants access. The player must unlock this stair (by completing
   * the POI that drops its key) before they can reach this POI.
   * Path-traversal POIs have `stairId: null`.
   */
  stairId: string | null;
}

/**
 * A Stair (T-210) — discrete level-design object that grants vertical
 * access from a path zone onto an adjacent wilderness plateau. The
 * matcher materializes one per wilderness POI it selects. The stair's
 * lock is what gates access; completing the upstream POI that drops
 * the lock's key trinket unlocks the stair and reveals the ramp.
 */
export interface StairInstance {
  id: string;
  /** Path-zone id the stair stands in. */
  fromZoneId: number;
  /** Wilderness-zone id the stair climbs to. */
  toZoneId: number;
  /** Grid-coords anchor pixel (a path-pixel touching the wilderness border). */
  anchorPixel: { x: number; y: number };
  /**
   * Trinket required to unlock the stair. `null` = unlocked by default
   * (a "found" stair, level-design hint visible from the start). The
   * trinket id matches a `TrinketInstance.id` in the same tile.
   */
  lockedBy: string | null;
}

/**
 * Tile-level narrative artifact — POIs placed, trinkets defined, DAG
 * structure as a derived shape. Internal scratch for the matcher in
 * `poi_network.ts`; the stage's output writes directly to
 * `state.level.narrative` / `state.level.edges.stairs`, so this type
 * does not appear on the threaded pipeline state past T-214.
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

/**
 * Marker state — same shape as `AnnotatedZoneState`. The `poiNetwork`
 * stage's only effect is to mutate `state.level.narrative` +
 * `state.level.edges.stairs`; no new pipeline-state fields are added.
 */
export type PoiNetworkState = AnnotatedZoneState;

/**
 * After the `fields` stage (T-311 P3): the per-cell render-field planes derived
 * from the topology + biome. Read by the Atlas inspector (heat overlays) and,
 * in a follow-up, threaded to the VegFieldGrid/SurfaceStateGrid/WaterGrid chunk
 * components. Adds no mutation to the existing buffers.
 */
export interface FieldsState extends PoiNetworkState {
  fields: import("./fields.ts").FieldPlanes;
}
