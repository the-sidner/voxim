/**
 * SpatialGrid — chunk-aligned entity index rebuilt once per tick.
 *
 * Cell size matches the terrain chunk size (16 world units) so queries align
 * with the existing spatial structure.  A radius-20 aggro scan touches at most
 * 9 cells (~9 entities on average), versus iterating all ~930 entities.
 *
 * Usage:
 *   grid.rebuild(world);                    // once per tick
 *   const ids = grid.nearby(x, y, radius); // O(cells in radius)
 *   const ids = grid.cell(cx, cy);         // exact cell, O(1)
 *
 * nearby() returns a reused internal buffer — iterate immediately, do not store.
 */

import type { World, EntityId } from "@voxim/engine";
import { Position } from "./components/game.ts";

// 512-unit world ÷ 16-unit cells = 32 cells per side.
const CELL_SIZE = 16;
const GRID_WIDTH = 32; // cells per side

function cellKey(cx: number, cy: number): number {
  return (cx & 0x3f) | ((cy & 0x3f) << 6);
}

export class SpatialGrid {
  private readonly cells = new Map<number, EntityId[]>();
  private readonly _buf: EntityId[] = [];

  /** Repopulate from all entities with a Position component. O(entities). */
  rebuild(world: World): void {
    // Clear without deallocating cell arrays — reuse allocations between ticks.
    for (const cell of this.cells.values()) cell.length = 0;

    for (const { entityId, position } of world.query(Position)) {
      const cx = Math.max(0, Math.min(GRID_WIDTH - 1, Math.floor(position.x / CELL_SIZE)));
      const cy = Math.max(0, Math.min(GRID_WIDTH - 1, Math.floor(position.y / CELL_SIZE)));
      const key = cellKey(cx, cy);
      let cell = this.cells.get(key);
      if (!cell) { cell = []; this.cells.set(key, cell); }
      cell.push(entityId);
    }
  }

  /**
   * All entity IDs in cells that overlap the circle (x, y, radius).
   * May include entities slightly outside the exact radius — distance-check if needed.
   * Returns a shared internal buffer; iterate and discard before the next call.
   */
  nearby(x: number, y: number, radius: number): readonly EntityId[] {
    const cx0 = Math.max(0, Math.floor((x - radius) / CELL_SIZE));
    const cy0 = Math.max(0, Math.floor((y - radius) / CELL_SIZE));
    const cx1 = Math.min(GRID_WIDTH - 1, Math.floor((x + radius) / CELL_SIZE));
    const cy1 = Math.min(GRID_WIDTH - 1, Math.floor((y + radius) / CELL_SIZE));

    this._buf.length = 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = this.cells.get(cellKey(cx, cy));
        if (cell) {
          for (let i = 0; i < cell.length; i++) this._buf.push(cell[i]);
        }
      }
    }
    return this._buf;
  }

  /** Entities in one exact cell. Returns empty array if cell is empty. */
  cell(cx: number, cy: number): readonly EntityId[] {
    return this.cells.get(cellKey(
      Math.max(0, Math.min(GRID_WIDTH - 1, cx)),
      Math.max(0, Math.min(GRID_WIDTH - 1, cy)),
    )) ?? [];
  }
}
