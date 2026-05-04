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
 * One macro-grid cell. The unit of worldmap persistence.
 *
 * Categorical / palette baskets and linear-feature specs are not yet
 * present; they will appear here in subsequent phases without breaking
 * the on-disk shape (the repo's payload column is bytea-flexible).
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
}

/** Top-level metadata + cells, what gets handed to the repo as a unit. */
export interface WorldMap {
  seed: number;
  width: number;
  height: number;
  cells: WorldCellRecord[];
}
