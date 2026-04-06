/**
 * Terrain query helpers.
 * These are pure functions — no world/ECS access. The caller fetches the
 * component data (Heightmap, MaterialGrid) and passes it in.
 */
import type { HeightmapData, MaterialGridData } from "./components.ts";

/** Tile constants */
export const TILE_SIZE = 512; // voxels
export const CHUNK_SIZE = 32; // voxels per chunk side
export const CHUNKS_PER_TILE_SIDE = TILE_SIZE / CHUNK_SIZE; // 16
export const CHUNKS_PER_TILE = CHUNKS_PER_TILE_SIDE * CHUNKS_PER_TILE_SIDE; // 256

/** Height precision — all terrain heights are multiples of this. */
export const HEIGHT_STEP = 0.25;

// ---- coordinate helpers ----

/** Convert world position to the chunk that contains it. */
export function worldToChunk(worldX: number, worldY: number): { chunkX: number; chunkY: number } {
  return {
    chunkX: Math.floor(worldX / CHUNK_SIZE),
    chunkY: Math.floor(worldY / CHUNK_SIZE),
  };
}

/** Convert world position to local position within its chunk. */
export function worldToLocal(
  worldX: number,
  worldY: number,
): { localX: number; localY: number } {
  return {
    localX: ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
    localY: ((worldY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
  };
}

/** Row-major index for a local (x, y) cell. */
export function cellIndex(localX: number, localY: number): number {
  return (localX | 0) + (localY | 0) * CHUNK_SIZE;
}

// ---- height queries ----

/** Get the height at a specific local cell. Returns 0 if out of range. */
export function getHeight(heightmap: HeightmapData, localX: number, localY: number): number {
  const ix = localX | 0;
  const iy = localY | 0;
  if (ix < 0 || ix >= CHUNK_SIZE || iy < 0 || iy >= CHUNK_SIZE) return 0;
  return heightmap.data[cellIndex(ix, iy)];
}

/**
 * Bilinear-interpolated height at a fractional local position.
 * Used by physics to get smooth terrain under a moving entity.
 */
export function getHeightInterp(heightmap: HeightmapData, localX: number, localY: number): number {
  const x0 = Math.floor(localX);
  const y0 = Math.floor(localY);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const tx = localX - x0;
  const ty = localY - y0;

  const h00 = getHeight(heightmap, x0, y0);
  const h10 = getHeight(heightmap, x1, y0);
  const h01 = getHeight(heightmap, x0, y1);
  const h11 = getHeight(heightmap, x1, y1);

  return h00 * (1 - tx) * (1 - ty) +
    h10 * tx * (1 - ty) +
    h01 * (1 - tx) * ty +
    h11 * tx * ty;
}

/** Get material ID at a specific local cell. Returns 0 if out of range. */
export function getMaterial(grid: MaterialGridData, localX: number, localY: number): number {
  const ix = localX | 0;
  const iy = localY | 0;
  if (ix < 0 || ix >= CHUNK_SIZE || iy < 0 || iy >= CHUNK_SIZE) return 0;
  return grid.data[cellIndex(ix, iy)];
}

// ---- height snapping ----

/** Snap a height value to the nearest HEIGHT_STEP increment. */
export function snapHeight(z: number): number {
  return Math.round(z / HEIGHT_STEP) * HEIGHT_STEP;
}
