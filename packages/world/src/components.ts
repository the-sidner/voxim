/**
 * Chunk component definitions.
 * Terrain is part of the ECS — chunks are entities, not a parallel system.
 * This means terrain modifications go through the same deferred write and delta path
 * as players, NPCs, and items.
 */
import { defineComponent } from "@voxim/engine";
import { heightmapCodec, materialGridCodec, openMaskCodec, kindGridCodec } from "@voxim/codecs";
import type { HeightmapData, MaterialGridData, OpenMaskData, KindGridData } from "@voxim/codecs";
import { ComponentType } from "@voxim/protocol";

export type { HeightmapData, MaterialGridData, OpenMaskData, KindGridData };

const CHUNK_CELLS = 32 * 32;

/**
 * Heightmap component.
 * data: 1024 float32 heights, row-major: index = localX + localY * 32.
 * Heights are multiples of 0.25 (terrain constraint; entity positions are full floats).
 */
export const Heightmap = defineComponent({
  name: "heightmap" as const,
  wireId: ComponentType.heightmap,
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
  wireId: ComponentType.materialGrid,
  codec: materialGridCodec,
  default: (): MaterialGridData => ({
    data: new Uint16Array(CHUNK_CELLS),
  }),
});

/**
 * OpenMask component — per-cell impassability for the chunk.
 *
 * data: 1024 uint8, same row-major layout as Heightmap.data. 1 = open
 * (player can walk here), 0 = closed (boundary; player is blocked).
 *
 * The truth for collision is THIS, not the heightmap step. With this
 * component populated, a tree boundary on flat ground blocks the player
 * the same way a +3u cliff does — the visual rendering of the boundary
 * (raised height vs. tree entity) is independent of the blocking.
 *
 * Networked so the client predictor can consult the same data the
 * server uses, avoiding rubber-band corrections at boundaries that
 * don't show up as a heightmap step (vegetation, water).
 */
export const OpenMask = defineComponent({
  name: "openMask" as const,
  wireId: ComponentType.openMask,
  codec: openMaskCodec,
  default: (): OpenMaskData => ({
    // Default: every cell open — a default chunk doesn't block anything
    // until terrain authoring (atlas) writes a real mask.
    data: new Uint8Array(CHUNK_CELLS).fill(1),
  }),
});

/**
 * KindGrid component — per-cell boundary kind id (atlas's BOUNDARY_KIND_*).
 *
 * Lets the client decorate forest / stone / water / etc. boundaries
 * locally without needing per-tree server entities. Server still gates
 * collision via OpenMask; KindGrid is purely a visual descriptor.
 *
 * Networked so the client can render decoration off the same chunk data
 * tile-server holds (no parallel atlas-fetch path on the client side).
 */
export const KindGrid = defineComponent({
  name: "kindGrid" as const,
  wireId: ComponentType.kindGrid,
  codec: kindGridCodec,
  default: (): KindGridData => ({
    data: new Uint16Array(CHUNK_CELLS),  // 0 = OPEN
  }),
});
