/**
 * Chunk entity factory.
 * Creates a chunk entity in the World with Heightmap and MaterialGrid components.
 */
import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { Heightmap, MaterialGrid } from "./components.ts";
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
