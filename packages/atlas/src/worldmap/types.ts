/**
 * Worldmap layer types.
 *
 * One WorldCellRecord per macro-grid cell. Each record holds:
 *   - The biome parameter bundle — continuous numeric fields the tilemap
 *     layer reads to decide what the tile looks like (Q3, Q5).
 *   - Gate specs per edge — where on each edge a gate sits, and which
 *     neighbour it leads to. Mirrored across shared edges (Q6 invariant).
 *
 * Linear features (rivers, roads) and categorical baskets are deferred.
 * Their slots will be added to this same record without breaking it —
 * the bundle is intentionally extensible (Q5).
 */

/** Compass edges, also used as nibble positions in the gate-summary u16. */
export type Edge = "north" | "east" | "south" | "west";

/** All edges in canonical [N, E, S, W] order. */
export const EDGES: readonly Edge[] = ["north", "east", "south", "west"];

/**
 * One gate sitting on a specific edge of a tile.
 *
 * `offset` is in WORLD units along the edge's perpendicular axis:
 *   north / south → x coordinate, in (0, tileWorldSize)
 *   east  / west  → y coordinate, in (0, tileWorldSize)
 *
 * Mirror invariant: a shared border between two cells uses the SAME
 * offset on both sides. Atlas computes one offset per shared edge and
 * writes it to both records.
 */
export interface GateSpec {
  offset: number;
  toCellX: number;
  toCellY: number;
}

/**
 * The biome parameter bundle. Continuous numeric fields. Phase 1 ships
 * the four below; the bundle grows by adding fields here without touching
 * consumers that don't read them (Q5).
 */
export interface BiomeParams {
  /** Cool 0 .. hot 1. */
  temperature: number;
  /** Dry 0 .. wet 1. */
  moisture: number;
  /** Lowland 0 .. mountain 1. */
  altitude: number;
  /** Smooth 0 .. choppy 1 — feeds tilemap noise frequency / threshold. */
  ruggedness: number;
}

/**
 * One endpoint of a river segment inside a tile. Either a crossing of
 * one of the tile's edges (with a world-unit offset along that edge),
 * or an interior terminal (river source or sink — world coords inside
 * the tile).
 *
 * Encoded as separate optional fields rather than a discriminated union
 * to keep the JSON shape flat and tolerant of jsonb round-trips.
 */
export interface RiverEndpoint {
  /** Edge of the tile this endpoint sits on. Absent for interior terminals. */
  edge?: Edge;
  /**
   * World-unit offset along the perpendicular axis of `edge`. Mirror
   * invariant: cell A's exit offset on edge X equals cell B's entry
   * offset on edge X' (where X' is the opposite edge in B).
   */
  offset?: number;
  /** World-unit interior coords. Set when `edge` is absent. */
  x?: number;
  y?: number;
}

export interface RiverSegment {
  a: RiverEndpoint;
  b: RiverEndpoint;
}

/**
 * One macro-grid cell. The unit of worldmap persistence.
 *
 * Linear features (rivers; later: roads) are per-cell SEGMENTS, not
 * continuous polylines. Each segment is one line through this tile;
 * cells the river crosses contribute one segment each. Cross-tile
 * coherence comes from the shared edge offset matching on both sides
 * (the same mirror invariant the gates use).
 */
export interface WorldCellRecord {
  cellX: number;
  cellY: number;
  biome: BiomeParams;
  /** null on world edges or wherever there's no neighbour to connect to. */
  gates: {
    north: GateSpec | null;
    east:  GateSpec | null;
    south: GateSpec | null;
    west:  GateSpec | null;
  };
  /** River segments crossing this tile. Empty for cells with no rivers. */
  rivers: RiverSegment[];
}

/** Top-level metadata + cells, what gets handed to the repo as a unit. */
export interface WorldMap {
  seed: number;
  width: number;
  height: number;
  cells: WorldCellRecord[];
}
