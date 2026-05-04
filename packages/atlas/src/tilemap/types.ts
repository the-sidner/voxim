/**
 * Tilemap layer types.
 *
 * One TileInit per tile. The shape is intentionally narrow for phase 2A —
 * holds only what the noise→rooms→portals backbone produces. Boundaries,
 * features, and full terrain buffers come in subsequent phases (2B+).
 *
 * Each pipeline stage is a pure function with typed inputs and outputs;
 * the orchestrator threads them. There is no shared mutable GenState.
 */

import type { Edge } from "../worldmap/types.ts";

/**
 * One connected open-pixel component at sample-grid resolution.
 *
 * `cx` / `cy` are world-unit centroids; `pixelCount` × pixelArea ≈ world area.
 * The pixel set itself is recoverable from `roomOf` (in TileInit) — we keep
 * the room record small so it round-trips through JSON cheaply.
 */
export interface Room {
  /** Stable id within the tile. Equals the index in TileInit.rooms. */
  id: number;
  /** Centroid in world units. */
  cx: number;
  cy: number;
  /** Number of sample-grid pixels owned by this room. */
  pixelCount: number;
}

/**
 * One portal: where a worldmap gate enters this tile + which room it lands in.
 *
 * `pixelX` / `pixelY` are sample-grid coords (the carved entry point).
 * `roomId` is the room the entry pixel belongs to after portal placement
 * has carved a small clearing (always non-null for placed portals).
 */
export interface Portal {
  edge: Edge;
  /** World-unit position along the edge. Mirror-matched on shared borders. */
  offset: number;
  pixelX: number;
  pixelY: number;
  roomId: number;
}

/**
 * One tile's pre-computed initial state. What atlas writes; what
 * tile-server reads at boot before applying player edits.
 *
 * Phase 2A populates: tileSize, gridSize, openMask, rooms, roomOf, portals.
 * Phase 2B+ adds: boundaries, features, heightmap, materialGrid.
 */
export interface TileInit {
  /** Worldmap cell this tile belongs to. */
  cellX: number;
  cellY: number;

  /** Side length of the playable tile in world units. */
  tileSize: number;
  /** Sample-grid resolution. tileSize / gridSize = world units per pixel. */
  gridSize: number;

  /** 1 = open, 0 = closed. Length = gridSize². Row-major. */
  openMask: Uint8Array;
  /**
   * Per-pixel room id, or 0xFFFF for closed/un-roomed pixels.
   * Length = gridSize². Row-major.
   *
   * `rooms[]` are the POST-network connected components — after the
   * corridor-carve pass merges chambers together, most tiles end up as
   * one big component. This is what `Portal.roomId` indexes into and
   * what `gateSummary` uses to express "all gates reachable".
   */
  roomOf: Uint16Array;

  rooms: Room[];

  /**
   * Per-pixel chamber id, or 0xFFFF for closed pixels AND for corridor
   * pixels carved by the network / portal stages. Length = gridSize².
   *
   * `chambers[]` are the PRE-network rooms — the discrete noise blobs
   * after roomify, before any corridors merged them. Use this to see the
   * actual chamber layout. Pixels open in `openMask` but with `0xFFFF`
   * here are corridors (the network's connective tissue).
   */
  chamberOf: Uint16Array;
  chambers: Room[];

  portals: Portal[];

  /**
   * Gate-summary u16 — which edge gates are internally connected.
   * Four nibbles in [N, E, S, W] order; component id (0..2) when a gate
   * is present, 0xF when absent. Two gates connected iff their nibbles
   * are equal (and neither is 0xF). See summary.ts.
   */
  gateSummary: number;

  /**
   * World-unit heights at sample-grid resolution, row-major. Length
   * gridSize². Wall pixels carry an added WALL_HEIGHT step so they
   * read as non-traversable boundaries; open pixels carry only the
   * biome's smooth floor modulation.
   */
  heightMap: Float32Array;

  /**
   * Per-pixel material ids from atlas's canonical set (MATERIAL_* in
   * pipeline/materials.ts). Length gridSize², row-major. Wall and floor
   * pixels both carry the underlying ground material — boundary kinds
   * (tree, rock, …) layer on top in a later phase.
   */
  materials: Uint16Array;

  /**
   * Per-pixel boundary-kind ids (BOUNDARY_KIND_* in
   * pipeline/boundary_kinds.ts). Length gridSize², row-major. Open
   * pixels are tagged BOUNDARY_KIND_OPEN (= 0); closed pixels carry
   * the kind that decides their visual + transform verbs.
   */
  kindOf: Uint16Array;

  // ---- placeholders for later phases ------------------------------
  /** Will be populated by phase 4 (boundary kinds, e.g. tree patches). */
  boundaries: unknown[];
  /** Will be populated by phase 4 (feature kinds, e.g. hearth slot). */
  features: unknown[];
}

/**
 * Wire-friendly version of TileInit — Uint8Array / Uint16Array become
 * base64 strings. Used by the JSON HTTP API and the jsonb DB column.
 */
export interface TileInitWire {
  cellX: number;
  cellY: number;
  tileSize: number;
  gridSize: number;
  openMaskB64: string;
  roomOfB64: string;
  chamberOfB64: string;
  /** Float32 heights, base64-encoded raw bytes (gridSize² × 4 bytes). */
  heightMapB64: string;
  /** Uint16 material ids, base64-encoded raw bytes (gridSize² × 2 bytes). */
  materialsB64: string;
  /** Uint16 boundary-kind ids, base64-encoded raw bytes (gridSize² × 2 bytes). */
  kindOfB64: string;
  rooms: Room[];
  chambers: Room[];
  portals: Portal[];
  gateSummary: number;
  boundaries: unknown[];
  features: unknown[];
}
