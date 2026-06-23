/**
 * BuildOccupancy (T-284) — the build cursor's per-column stack counter, the one
 * piece of client state behind "place a voxel → the next ghost in that column
 * floats one higher." Single-source-of-truth: it mirrors the placed-voxel
 * entities ClientWorld already holds (each placed wall/voxel is a `blueprint`
 * entity), so it can never drift — game.ts feeds it `add`/`remove` at the exact
 * entity spawn/destroy sites, and `stackHeight` is just that column's count.
 *
 * Deliberately NOT a layered occupancy grid (deferred to a later chunk with
 * side-face placement). Top-only stacking needs only a per-column count.
 */
const key = (cx: number, cy: number): string => `${cx},${cy}`;

export class BuildOccupancy {
  /** column "cx,cy" → set of placed-voxel entity ids in that column. */
  private readonly columns = new Map<string, Set<string>>();
  /** entity id → its column key, so `remove` is O(1) without a position. */
  private readonly entityColumn = new Map<string, string>();

  /** Record a placed-voxel entity at world (x,y) — idempotent per entity id. */
  add(entityId: string, worldX: number, worldY: number): void {
    if (this.entityColumn.has(entityId)) return;
    const k = key(Math.floor(worldX), Math.floor(worldY));
    let set = this.columns.get(k);
    if (!set) this.columns.set(k, set = new Set());
    set.add(entityId);
    this.entityColumn.set(entityId, k);
  }

  /** Forget a placed-voxel entity (destroyed / left AoI). */
  remove(entityId: string): void {
    const k = this.entityColumn.get(entityId);
    if (k === undefined) return;
    this.entityColumn.delete(entityId);
    const set = this.columns.get(k);
    if (set) {
      set.delete(entityId);
      if (set.size === 0) this.columns.delete(k);
    }
  }

  /** Voxels already stacked in this column (0 = bare terrain). */
  stackHeight(cellX: number, cellY: number): number {
    return this.columns.get(key(cellX, cellY))?.size ?? 0;
  }

  /** Drop all state (tile transition / world clear). */
  clear(): void {
    this.columns.clear();
    this.entityColumn.clear();
  }
}
