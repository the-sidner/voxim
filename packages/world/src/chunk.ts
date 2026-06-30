/**
 * Chunk entity factory.
 * Creates a chunk entity in the World with Heightmap and MaterialGrid components.
 */
import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { Heightmap, MaterialGrid, OpenMask, KindGrid, VegFieldGrid, SurfaceStateGrid, WaterGrid } from "./components.ts";
import type { VegFieldGridData, SurfaceStateGridData } from "./components.ts";
import { CHUNK_SIZE } from "./terrain.ts";

const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE;

/**
 * Create a chunk entity.
 * Heights default to 0; call setChunkHeights() or the world generator to populate them.
 * Returns the entity ID so the caller can reference the chunk later.
 */
export function createChunk(world: World, chunkX: number, chunkY: number): EntityId {
  const id = newEntityId();
  world.create(id);

  world.write(id, Heightmap, {
    data: new Float32Array(CHUNK_CELLS),
    chunkX,
    chunkY,
  });

  world.write(id, MaterialGrid, {
    data: new Uint16Array(CHUNK_CELLS),
  });

  // Default-open: a chunk without a written openMask doesn't block anything.
  world.write(id, OpenMask, {
    data: new Uint8Array(CHUNK_CELLS).fill(1),
  });

  // Default-untagged: 0 = OPEN. Decoration renderer skips these.
  world.write(id, KindGrid, {
    data: new Uint16Array(CHUNK_CELLS),
  });

  // T-311 P3 render-field grids — default to neutral (zeros / NaN); the atlas
  // derivation writes the real fields (Phase-3 commit 2). Render-only, never collision.
  world.write(id, VegFieldGrid, {
    canopyLight: new Uint8Array(CHUNK_CELLS),
    corruption: new Uint8Array(CHUNK_CELLS),
    fertility: new Uint8Array(CHUNK_CELLS),
  });
  world.write(id, SurfaceStateGrid, {
    wetness: new Uint8Array(CHUNK_CELLS),
    overgrowth: new Uint8Array(CHUNK_CELLS),
    wear: new Uint8Array(CHUNK_CELLS),
    variantIndex: new Uint8Array(CHUNK_CELLS),
    ruinAge: new Uint8Array(CHUNK_CELLS),
    traffic: new Uint8Array(CHUNK_CELLS),
  });
  world.write(id, WaterGrid, {
    surfaceLevel: new Float32Array(CHUNK_CELLS).fill(NaN),
  });

  return id;
}

/**
 * Overwrite a chunk's height data via immediate write.
 * Used during world generation before the tick loop starts.
 */
export function setChunkHeights(
  world: World,
  chunkId: EntityId,
  heights: Float32Array,
): void {
  const existing = world.get(chunkId, Heightmap);
  if (!existing) throw new Error(`setChunkHeights: chunk ${chunkId} has no Heightmap`);
  world.write(chunkId, Heightmap, { ...existing, data: heights });
}

/**
 * Overwrite a chunk's material data via immediate write.
 */
export function setChunkMaterials(
  world: World,
  chunkId: EntityId,
  materials: Uint16Array,
): void {
  const existing = world.get(chunkId, MaterialGrid);
  if (!existing) throw new Error(`setChunkMaterials: chunk ${chunkId} has no MaterialGrid`);
  world.write(chunkId, MaterialGrid, { ...existing, data: materials });
}

/**
 * Overwrite a chunk's openMask via immediate write. 1 = open, 0 = closed.
 */
export function setChunkOpenness(
  world: World,
  chunkId: EntityId,
  open: Uint8Array,
): void {
  const existing = world.get(chunkId, OpenMask);
  if (!existing) throw new Error(`setChunkOpenness: chunk ${chunkId} has no OpenMask`);
  world.write(chunkId, OpenMask, { ...existing, data: open });
}

/**
 * Overwrite a chunk's kindGrid via immediate write. Each cell carries a
 * BOUNDARY_KIND_* id from atlas's set; 0 = OPEN.
 */
export function setChunkKinds(
  world: World,
  chunkId: EntityId,
  kinds: Uint16Array,
): void {
  const existing = world.get(chunkId, KindGrid);
  if (!existing) throw new Error(`setChunkKinds: chunk ${chunkId} has no KindGrid`);
  world.write(chunkId, KindGrid, { ...existing, data: kinds });
}

/** Overwrite a chunk's VegFieldGrid (T-311 P3) — atlas-derived render fields. */
export function setChunkVegField(world: World, chunkId: EntityId, data: VegFieldGridData): void {
  if (!world.get(chunkId, VegFieldGrid)) throw new Error(`setChunkVegField: chunk ${chunkId} has no VegFieldGrid`);
  world.write(chunkId, VegFieldGrid, data);
}

/** Overwrite a chunk's SurfaceStateGrid (T-311 P3). */
export function setChunkSurfaceState(world: World, chunkId: EntityId, data: SurfaceStateGridData): void {
  if (!world.get(chunkId, SurfaceStateGrid)) throw new Error(`setChunkSurfaceState: chunk ${chunkId} has no SurfaceStateGrid`);
  world.write(chunkId, SurfaceStateGrid, data);
}

/** Overwrite a chunk's WaterGrid surface levels (T-311 P3). NaN = no water. */
export function setChunkWater(world: World, chunkId: EntityId, surfaceLevel: Float32Array): void {
  if (!world.get(chunkId, WaterGrid)) throw new Error(`setChunkWater: chunk ${chunkId} has no WaterGrid`);
  world.write(chunkId, WaterGrid, { surfaceLevel });
}
