/**
 * Fog-of-war wire-shape constants (T-157; LOS tuning moved out T-315 D5).
 *
 * These describe the fog *bitmap layout* — cell resolution and index
 * packing — which both server and client must agree on byte-for-byte.
 * Don't redefine them in either codebase — import from here so they can
 * never drift.
 *
 * Resolution choice: 256×256 fog cells covering the 512-unit tile means
 * one fog cell per 2×2 world units.  Walls in this world are 2u thick
 * (T-156), so the fog grid aligns with wall geometry — players don't
 * see the resolution drop at game speed.  `seenEver` is bit-packed
 * (8 KB per tile per player); reveal events use u16 cell indices
 * (256² = 65536 fits exactly in u16).
 *
 * LOS *gameplay* tuning (cone angle, radius, ray count, step) is not
 * wire-shape — it lives in `GameConfig.fogOfWar` (content), not here.
 * protocol keeps only the wire-shape constants; ContentStore is the only
 * data path for tuning (see CLAUDE.md doctrine).
 */

/** Fog cells per tile axis. */
export const FOG_GRID_SIZE = 256;

/** World units per fog cell. */
export const FOG_CELL_SIZE = 2;

/** Total fog cells per tile. */
export const FOG_CELL_COUNT = FOG_GRID_SIZE * FOG_GRID_SIZE; // 65536

/** Bytes for the bit-packed `seenEver` bitmap of one tile. */
export const FOG_GRID_BYTES = FOG_CELL_COUNT / 8; // 8192

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
