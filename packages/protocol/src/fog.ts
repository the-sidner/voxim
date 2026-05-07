/**
 * Fog-of-war shared constants (T-157).
 *
 * Both the server and the client run the same LOS algorithm with these
 * exact numbers.  Don't redefine them in either codebase — import from
 * here so they can never drift.
 *
 * Resolution choice: 256×256 fog cells covering the 512-unit tile means
 * one fog cell per 2×2 world units.  Walls in this world are 2u thick
 * (T-156), so the fog grid aligns with wall geometry — players don't
 * see the resolution drop at game speed.  `seenEver` is bit-packed
 * (8 KB per tile per player); reveal events use u16 cell indices
 * (256² = 65536 fits exactly in u16).
 */

/** Fog cells per tile axis. */
export const FOG_GRID_SIZE = 256;

/** World units per fog cell. */
export const FOG_CELL_SIZE = 2;

/** Total fog cells per tile. */
export const FOG_CELL_COUNT = FOG_GRID_SIZE * FOG_GRID_SIZE; // 65536

/** Bytes for the bit-packed `seenEver` bitmap of one tile. */
export const FOG_GRID_BYTES = FOG_CELL_COUNT / 8; // 8192

/** Half-angle of the LOS cone in radians (≈55°, total ≈110°). */
export const LOS_HALF_ANGLE_RAD = (110 * Math.PI / 180) / 2;

/** LOS radius in world units. */
export const LOS_RADIUS = 40;

/** Number of rays in the cone — 1 ray per degree gives 110 rays. */
export const LOS_RAY_COUNT = 110;

/** Ray walk step in world units.  Smaller = fewer cell skips at oblique angles. */
export const LOS_STEP = 0.5;

/** Convert a world coord to a fog cell index along one axis. */
export function fogCellIndex(world: number): number {
  return Math.floor(world / FOG_CELL_SIZE);
}

/** Pack (cellX, cellY) into a single u16 cell index for wire/storage. */
export function packFogCell(cx: number, cy: number): number {
  return cx + cy * FOG_GRID_SIZE;
}

/** Unpack a u16 cell index back into (cellX, cellY). */
export function unpackFogCell(idx: number): { cx: number; cy: number } {
  return { cx: idx % FOG_GRID_SIZE, cy: Math.floor(idx / FOG_GRID_SIZE) };
}
