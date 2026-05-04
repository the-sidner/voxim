/**
 * Atlas-driven terrain loader.
 *
 * Tile-server stops generating terrain at boot. Instead it fetches the
 * pre-computed TileInit row written by atlas, decodes it, and upsamples
 * to tile-server's voxel resolution (TILE_SIZE²). Atlas is now the
 * single source of truth for terrain — no fallback path here.
 *
 * Boot ordering: atlas eagerly populates tile_init for every cell at
 * startup, but compose can race tile-server up before atlas's first
 * generation completes. We poll the repo with a short retry loop;
 * docker-compose dependencies should normally make this succeed on
 * the first try.
 */

import type { AtlasTileInitRepo } from "@voxim/db";
import type { ContentStore } from "@voxim/content";
import {
  tileInitFromWire,
  upsampleTile,
  MATERIAL_GRASS, MATERIAL_DIRT, MATERIAL_STONE, MATERIAL_SAND, MATERIAL_WATER,
  type TileInitWire,
} from "@voxim/atlas";
import { TILE_SIZE } from "@voxim/world";

export interface AtlasTerrainResult {
  heightBuffer: Float32Array;
  materialBuffer: Uint16Array;
  /** Atlas's per-tile seed. Used as the seed for downstream procedural systems. */
  tileSeed: number;
  cellX: number;
  cellY: number;
}

export interface LoadOptions {
  worldId?: string;
  /** Total retries before giving up. Default 30 (~30s with 1s sleep). */
  maxRetries?: number;
  /** Milliseconds between retries. Default 1000. */
  retryDelayMs?: number;
}

/**
 * Convert tile-server's `tile_N` id into atlas's `cellX_cellY` key.
 * Indexing convention: row-major across the macro grid, matching the
 * coordinator's WORLD_TILES list order.
 */
export function tileIdToAtlasKey(tileId: string, worldWidth: number): {
  atlasKey: string;
  cellX: number;
  cellY: number;
} {
  const m = tileId.match(/^tile_(\d+)$/);
  if (!m) {
    throw new Error(
      `tile id "${tileId}" does not match the tile_<n> convention; ` +
      `cannot derive (cellX, cellY) for atlas lookup`,
    );
  }
  const idx = parseInt(m[1]);
  const cellX = idx % worldWidth;
  const cellY = Math.floor(idx / worldWidth);
  return { atlasKey: `${cellX}_${cellY}`, cellX, cellY };
}

/**
 * Build the atlas-id → tile-server-id translation table.
 *
 * Atlas emits stable semantic ids (MATERIAL_GRASS = 1, etc.). Tile-server
 * has its own content registry with materials keyed by name. Look each
 * one up by name; missing entries throw — atlas content is meant to map
 * 1:1 onto tile-server's catalog.
 */
function buildMaterialMap(content: ContentStore): {
  materialMap: Map<number, number>;
  defaultMaterialId: number;
} {
  const byName = (name: string): number => {
    const m = content.getMaterialByName(name);
    if (!m) throw new Error(`atlas terrain: tile-server content missing material "${name}"`);
    return m.id;
  };
  const map = new Map<number, number>();
  map.set(MATERIAL_GRASS, byName("grass"));
  map.set(MATERIAL_DIRT,  byName("dirt"));
  map.set(MATERIAL_STONE, byName("stone"));
  map.set(MATERIAL_SAND,  byName("sand"));
  // Atlas's WATER falls back to mud — content has no water material yet.
  // When phase 4 boundary kinds land, water boundaries will own their own
  // visual instead of leaning on the ground material.
  map.set(MATERIAL_WATER, byName("mud"));
  return { materialMap: map, defaultMaterialId: byName("dirt") };
}

export async function loadTerrainFromAtlas(
  repo: AtlasTileInitRepo,
  tileId: string,
  worldWidth: number,
  content: ContentStore,
  opts: LoadOptions = {},
): Promise<AtlasTerrainResult> {
  const worldId      = opts.worldId      ?? "default";
  const maxRetries   = opts.maxRetries   ?? 30;
  const retryDelayMs = opts.retryDelayMs ?? 1000;

  const { atlasKey, cellX, cellY } = tileIdToAtlasKey(tileId, worldWidth);

  // Poll until atlas has populated the row.
  let row: Awaited<ReturnType<AtlasTileInitRepo["get"]>> = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    row = await repo.get(atlasKey, worldId);
    if (row) break;
    if (attempt === 0) {
      console.log(`[TileServer] waiting for atlas tile_init row "${atlasKey}"…`);
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  if (!row) {
    throw new Error(
      `atlas terrain: no tile_init row "${atlasKey}" after ${maxRetries} attempts; ` +
      `is the atlas service running and has it generated this world?`,
    );
  }

  const tile = tileInitFromWire(row.payload as unknown as TileInitWire);
  const { materialMap, defaultMaterialId } = buildMaterialMap(content);
  const { heightBuffer, materialBuffer } = upsampleTile(tile, {
    targetSize: TILE_SIZE,
    materialMap,
    defaultMaterialId,
  });

  return {
    heightBuffer,
    materialBuffer,
    tileSeed: Number(row.seed),
    cellX,
    cellY,
  };
}
