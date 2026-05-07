/**
 * Chunk entity factory.
 * Creates a chunk entity in the World with Heightmap and MaterialGrid components.
 */
import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { Heightmap, MaterialGrid, OpenMask, KindGrid } from "./components.ts";
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
