/**
 * The ONE shared build-line helper (T-284). Both the ghost preview
 * (BuildGhostRenderer) and the commit (game.ts) consume the SAME `brushCells`
 * list, so "the ghost shows X but the commit does Y" is structurally impossible.
 *
 * Previously `bresenhamCells` was duplicated verbatim in build_ghost.ts and
 * game.ts with subtly different start-cell conventions — unified here to one
 * INCLUSIVE-of-both-endpoints rasterizer, with spacing applied by `brushCells`.
 */
import type { BuildBrush, VoxelHit } from "./context.ts";

/** A column in the build grid — the integer-pair subset of a VoxelHit. */
export interface Cell {
  cellX: number;
  cellY: number;
}

/**
 * Integer Bresenham line between two cells, INCLUSIVE of both endpoints — one
 * canonical convention; callers slice if they want to drop an endpoint.
 */
export function bresenhamCells(a: Cell, b: Cell): Cell[] {
  const cells: Cell[] = [];
  let x0 = a.cellX, y0 = a.cellY;
  const x1 = b.cellX, y1 = b.cellY;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    cells.push({ cellX: x0, cellY: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return cells;
}

/**
 * Resolve the brush's footprint of cells for the current cursor target.
 *   - "single" (or no staged anchor): just the cursor cell.
 *   - "line": the Bresenham run from the staged anchor to the cursor, decimated
 *     by `spacing` — keep every (spacing+1)-th cell by index (so the anchor, at
 *     index 0, is always kept and diagonals stay evenly spaced). spacing 0 = solid.
 */
export function brushCells(brush: BuildBrush, anchor: VoxelHit | null, hit: VoxelHit): Cell[] {
  const hitCell: Cell = { cellX: hit.cellX, cellY: hit.cellY };
  if (brush.tool === "single" || !anchor) return [hitCell];

  const line = bresenhamCells({ cellX: anchor.cellX, cellY: anchor.cellY }, hitCell);
  const step = Math.max(1, brush.spacing + 1);
  if (step === 1) return line;
  return line.filter((_, i) => i % step === 0);
}
