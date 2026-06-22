/**
 * EnclosureSystem (T-065, server core) — caches which world cells are sealed
 * inside walls, recomputing only when walls change.
 *
 * "Walls" are derived from the live chunk grids: a cell is a WALL when its
 * OpenMask entry is 0 (closed / impassable — the same truth physics collides
 * against). Everything else is OPEN. A built structure (a finished wall
 * blueprint) flips its cell's OpenMask to closed, so a ring of completed walls
 * reads as a ring of WALL cells, and `enclosure_detector` flood-fills the OPEN
 * cells from the tile boundary: any OPEN cell the flood can't reach is enclosed.
 *
 * The detection itself is the pure `detectEnclosedCells` (unit-tested with
 * hand-built grids). This system only:
 *   - assembles a dense wall grid from whichever Heightmap+OpenMask chunks are
 *     currently loaded (chunks stream in/out per T-064), spanning their
 *     bounding box; cells outside the loaded set read OPEN, so the flood leaks
 *     to the world beyond a partially-loaded tile (conservative — an enclosure
 *     straddling the loaded edge is treated as not-yet-sealed),
 *   - runs the detector and caches the enclosed-cell set keyed by WORLD cell
 *     ("wx,wy"),
 *   - recomputes only on a wall-change signal, never every tick.
 *
 * Recompute trigger (v1): `BuildingCompleted` — a wall blueprint finishing is
 * what closes a cell. Collected on the bus the TriggerSystem/NpcSensory way
 * (subscribe → set a dirty flag at flush time; drain at the top of the next
 * run). The terrain-dig path (digging a wall back open) is a follow-up: dig
 * lowers a heightmap cell but the current dig handler does not flip OpenMask,
 * so it does not yet change wall topology. When a runtime OpenMask edit lands
 * (the same edit gate phase 6D mentions), route it through `markDirty()` too.
 *
 * Queryable state: `isEnclosed(worldX, worldY)` — the dual of how other
 * systems expose derived state (NpcSensory's job writes, FogOfWar's grid). The
 * protocol `EnclosureChanged` event + client roof rendering are T-066; this
 * system deliberately publishes nothing on the wire yet (server-local, the way
 * buff/modifier/resource state started).
 */
import type { World, EventBus } from "@voxim/engine";
import { Heightmap, OpenMask, CHUNK_SIZE } from "@voxim/world";
import type { OpenMaskData } from "@voxim/world";
import { TileEvents } from "@voxim/protocol";
import type { System, EventEmitter } from "../system.ts";
import {
  cellKey,
  detectEnclosedCells,
  type WallGrid,
} from "../enclosure_detector.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("EnclosureSystem");

export class EnclosureSystem implements System {
  /**
   * Runs after PlacementSystem so a wall deployed this tick is in the
   * committed world before we (next-tick) recompute off its closed cell.
   */
  readonly dependsOn = ["PlacementSystem"];

  /** Enclosed WORLD cells, keyed "wx,wy". Swapped wholesale on recompute. */
  private enclosed = new Set<string>();

  /**
   * Recompute pending — set by the bus collector at flush time, drained at the
   * top of the next run. Starts true so the first run establishes the initial
   * enclosure set from boot terrain.
   */
  private dirty = true;

  /**
   * Hang the wall-change collector on the real tile event bus (the
   * TriggerSystem/NpcSensory pattern). Called once from TileServer after the
   * world + bus are constructed. The collector only flips the dirty flag — no
   * world reads at flush time; the recompute happens in `run`.
   */
  registerSubscribers(bus: EventBus): void {
    bus.subscribe(TileEvents.BuildingCompleted, () => this.markDirty());
  }

  /** Mark the cache stale so the next run recomputes. */
  markDirty(): void {
    this.dirty = true;
  }

  run(world: World, _events: EventEmitter, _dt: number): void {
    if (!this.dirty) return;
    this.dirty = false;

    const { grid, originX, originY } = buildWallGrid(world);
    if (!grid) {
      // No loaded chunks → nothing can be enclosed.
      if (this.enclosed.size) this.enclosed = new Set();
      return;
    }
    const local = detectEnclosedCells(grid);

    // Re-key from grid-local cells to absolute WORLD cells so queries can use
    // entity world positions directly.
    const next = new Set<string>();
    for (const key of local) {
      const comma = key.indexOf(",");
      const lx = Number(key.slice(0, comma));
      const ly = Number(key.slice(comma + 1));
      next.add(cellKey(originX + lx, originY + ly));
    }
    this.enclosed = next;
    log.debug("recomputed enclosure: %d enclosed cells", next.size);
  }

  /**
   * True if the world cell containing (worldX, worldY) is sealed inside walls.
   * Floors to the integer cell the same way collision + placement do.
   */
  isEnclosed(worldX: number, worldY: number): boolean {
    return this.enclosed.has(cellKey(Math.floor(worldX), Math.floor(worldY)));
  }

  /** Read-only view of the enclosed world-cell set (for T-066 / tests). */
  enclosedCells(): ReadonlySet<string> {
    return this.enclosed;
  }
}

/**
 * Assemble a dense wall grid spanning the bounding box of every loaded chunk's
 * OpenMask, in WORLD-cell space. Returns the grid plus its world-cell origin so
 * the caller can map grid-local cells back to world cells. `grid` is null when
 * no chunk is loaded.
 *
 * A cell is a WALL when its OpenMask entry is 0 (closed); cells in the bounding
 * box that belong to no loaded chunk read OPEN, so the boundary flood leaks
 * past the loaded region — an enclosure must be fully inside loaded chunks to
 * register, which is correct (gameplay only ever builds near players, where
 * chunks are loaded).
 */
function buildWallGrid(world: World): {
  grid: WallGrid | null;
  originX: number;
  originY: number;
} {
  // Join OpenMask with Heightmap (OpenMask carries no chunk coords itself).
  const chunks: Array<{ chunkX: number; chunkY: number; open: OpenMaskData }> = [];
  let minCX = Infinity, minCY = Infinity, maxCX = -Infinity, maxCY = -Infinity;
  for (const { entityId, heightmap } of world.query(Heightmap)) {
    const om = world.get(entityId, OpenMask);
    if (!om) continue;
    chunks.push({ chunkX: heightmap.chunkX, chunkY: heightmap.chunkY, open: om });
    if (heightmap.chunkX < minCX) minCX = heightmap.chunkX;
    if (heightmap.chunkY < minCY) minCY = heightmap.chunkY;
    if (heightmap.chunkX > maxCX) maxCX = heightmap.chunkX;
    if (heightmap.chunkY > maxCY) maxCY = heightmap.chunkY;
  }
  if (chunks.length === 0) return { grid: null, originX: 0, originY: 0 };

  const originX = minCX * CHUNK_SIZE;
  const originY = minCY * CHUNK_SIZE;
  const width = (maxCX - minCX + 1) * CHUNK_SIZE;
  const height = (maxCY - minCY + 1) * CHUNK_SIZE;

  // Dense wall buffer over the bounding box; default 0 (OPEN) for gaps.
  const walls = new Uint8Array(width * height);
  for (const { chunkX, chunkY, open } of chunks) {
    const baseX = (chunkX - minCX) * CHUNK_SIZE;
    const baseY = (chunkY - minCY) * CHUNK_SIZE;
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        // OpenMask: 1 = open, 0 = closed (wall).
        if (open.data[lx + ly * CHUNK_SIZE] === 0) {
          walls[(baseX + lx) + (baseY + ly) * width] = 1;
        }
      }
    }
  }

  const grid: WallGrid = {
    width,
    height,
    isWall: (x, y) => {
      if (x < 0 || x >= width || y < 0 || y >= height) return false;
      return walls[x + y * width] !== 0;
    },
  };
  return { grid, originX, originY };
}
