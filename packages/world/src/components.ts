/**
 * Chunk component definitions.
 * Terrain is part of the ECS — chunks are entities, not a parallel system.
 * This means terrain modifications go through the same deferred write and delta path
 * as players, NPCs, and items.
 */
import { defineComponent } from "@voxim/engine";
import { heightmapCodec, materialGridCodec } from "@voxim/codecs";
import type { HeightmapData, MaterialGridData } from "@voxim/codecs";

export type { HeightmapData, MaterialGridData };

const CHUNK_CELLS = 32 * 32;

/**
 * Heightmap component.
 * data: 1024 float32 heights, row-major: index = localX + localY * 32.
 * Heights are multiples of 0.25 (terrain constraint; entity positions are full floats).
 */
export const Heightmap = defineComponent({
  name: "heightmap" as const,
  codec: heightmapCodec,
  default: (): HeightmapData => ({
    data: new Float32Array(CHUNK_CELLS),
    chunkX: 0,
    chunkY: 0,
  }),
});

/**
 * MaterialGrid component.
 * data: 1024 uint16 material IDs, same row-major layout as Heightmap.data.
 * Material ID 0 = void/air. Concrete material definitions live in @voxim/content.
 */
export const MaterialGrid = defineComponent({
  name: "materialGrid" as const,
  codec: materialGridCodec,
  default: (): MaterialGridData => ({
    data: new Uint16Array(CHUNK_CELLS),
  }),
});
