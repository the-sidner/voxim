/**
 * Atlas-driven terrain loader.
 *
 * Tile-server stops generating terrain at boot. Instead it queries the
 * latest baked world via WorldsRepo, fetches its tile_init row from
 * AtlasTileInitRepo, decodes, and upsamples to tile-server's voxel
 * resolution (TILE_SIZE²). Atlas is the single source of truth.
 *
 * Boot ordering: atlas's bootstrap-on-empty creates a world if none
 * exists, but compose can race tile-server up before atlas finishes its
 * first bake. We poll for both the active world and its tile_init row;
 * docker-compose dependencies normally make this succeed first try.
 */

import type { AtlasTileInitRepo, AtlasWorldRepo, WorldRow, WorldsRepo } from "@voxim/db";
import type { GatePosition } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { World } from "@voxim/engine";
import {
  tileInitFromWire,
  upsampleTile,
  MATERIAL_GRASS, MATERIAL_DIRT, MATERIAL_STONE, MATERIAL_SAND, MATERIAL_WATER,
  BOUNDARY_KIND_VEGETATION,
  type TileInitWire,
} from "@voxim/atlas";
import { TILE_SIZE } from "@voxim/world";
import { spawnPrefab } from "./spawner.ts";

export interface AtlasTerrainResult {
  heightBuffer: Float32Array;
  materialBuffer: Uint16Array;
  /**
   * Per-cell openness at TILE_SIZE² resolution. 1 = open, 0 = closed.
   * Drives openMask-based collision in tile-server's physics; closed
   * pixels block movement regardless of how the boundary chooses to
   * render (cliff step, tree entity, water, …).
   */
  openBuffer: Uint8Array;
  /**
   * Per-cell boundary-kind ids at TILE_SIZE² resolution. 0 = open;
   * BOUNDARY_KIND_CLIFF / VEGETATION / WATER on closed pixels. Tile-server
   * uses this to spawn the right boundary visualisation (tree entities
   * at vegetation pixels, etc.).
   */
  kindBuffer: Uint16Array;
  /**
   * Initial gate-summary u16 from atlas. Tile-server publishes this to
   * coordinator on boot so the world-graph aggregate gets seeded; phase
   * 6D republishes whenever a runtime openMask edit changes the summary.
   */
  gateSummary: number;
  /** Atlas's per-tile seed. Used as the seed for downstream procedural systems. */
  tileSeed: number;
  cellX: number;
  cellY: number;
  /** The active world the tile was loaded from. Drives save scoping + restart polling. */
  world: WorldRow;
  /**
   * Gate positions derived from the worldmap cell's gates. Each present
   * edge becomes one GatePosition with the destination tile id resolved
   * from the neighbouring cell's coords (tile id convention: cellX_cellY).
   * Spawned as entities by tile-server's gate system.
   */
  gatePositions: GatePosition[];
}

export interface LoadOptions {
  /** Total retries before giving up. Default 30 (~30s with 1s sleep). */
  maxRetries?: number;
  /** Milliseconds between retries. Default 1000. */
  retryDelayMs?: number;
}

/**
 * Tile id convention: `cellX_cellY`. Each tile-server process binds to
 * one tile id at boot via the TILE_ID env. The (cellX, cellY) parsed out
 * is what atlas's tile_init rows are keyed by.
 */
export function parseTileId(tileId: string): { cellX: number; cellY: number } {
  const m = tileId.match(/^(\d+)_(\d+)$/);
  if (!m) {
    throw new Error(
      `tile id "${tileId}" does not match the cellX_cellY convention ` +
      `(e.g. "0_0" or "2_3"); cannot derive cell coords for atlas lookup`,
    );
  }
  return { cellX: parseInt(m[1]), cellY: parseInt(m[2]) };
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
  worldsRepo: WorldsRepo,
  cellsRepo: AtlasWorldRepo,
  tilesRepo: AtlasTileInitRepo,
  tileId: string,
  content: ContentStore,
  opts: LoadOptions = {},
): Promise<AtlasTerrainResult> {
  const maxRetries   = opts.maxRetries   ?? 30;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const { cellX, cellY } = parseTileId(tileId);

  // Poll for the active world AND its tile_init row. Either may be missing
  // transiently while atlas's bootstrap bake is in flight.
  let world: WorldRow | null = null;
  let row: Awaited<ReturnType<AtlasTileInitRepo["get"]>> = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    world = await worldsRepo.getLatest();
    if (world) row = await tilesRepo.get(world.id, tileId);
    if (world && row) break;
    if (attempt === 0) {
      console.log(
        `[TileServer] waiting for atlas (` +
        `${world ? `tile ${tileId}` : "active world"})…`,
      );
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  if (!world) {
    throw new Error(`atlas terrain: no active world after ${maxRetries} attempts`);
  }
  if (!row) {
    throw new Error(
      `atlas terrain: no tile_init "${tileId}" in world ${world.id} after ${maxRetries} attempts; ` +
      `is the world's bake complete and is this tile id valid for its dims?`,
    );
  }

  // Cell metadata (gates, biome, rivers) lives in atlas_world_cells. We
  // load it for THIS cell to derive GatePositions for the gate system.
  const cells = await cellsRepo.load(world.id);
  const cellRow = cells?.cells.find((c) => c.cellX === cellX && c.cellY === cellY);
  const gates = (cellRow?.gates ?? {}) as Record<string,
    { offset: number; toCellX: number; toCellY: number } | null>;
  const gatePositions: GatePosition[] = [];
  for (const edge of ["north", "east", "south", "west"] as const) {
    const g = gates[edge];
    if (!g) continue;
    // Note: protocol's GatePosition is currently edge-only (offset lives
    // inside atlas's tile_init.portals[]). Until tile-server's gate system
    // honours per-edge offsets, gates spawn at edge midpoints — a small
    // visual disagreement vs. the inspector's gate dots.
    gatePositions.push({
      edge,
      toTileId: `${g.toCellX}_${g.toCellY}`,
    });
  }

  const tile = tileInitFromWire(row.payload as unknown as TileInitWire);
  const { materialMap, defaultMaterialId } = buildMaterialMap(content);
  const { heightBuffer, materialBuffer, openBuffer, kindBuffer } = upsampleTile(tile, {
    targetSize: TILE_SIZE,
    materialMap,
    defaultMaterialId,
  });

  return {
    heightBuffer,
    materialBuffer,
    openBuffer,
    kindBuffer,
    gateSummary: tile.gateSummary,
    tileSeed: Number(row.seed),
    cellX,
    cellY,
    world,
    gatePositions,
  };
}

/**
 * Spawn boundary entities for kinds that render as world objects rather
 * than terrain modifications. Phase 4C: vegetation pixels get a `tree`
 * prefab. Cliffs are pure terrain; water (when wired) will be too.
 *
 * Sub-sampling: scanning every TILE_SIZE pixel produces too many entities
 * (a forest cell would hit thousands). We sample on a coarser stride
 * (every TREE_STRIDE world units) and spawn one tree per stride cell whose
 * sample point is vegetation. With STRIDE = 8 the densest forest yields
 * roughly 64×64 ≈ 4096 sample points per tile × ~30% vegetation density =
 * ~1200 trees — too many. STRIDE = 16 → 1024 × 30% = ~300. We default to 16.
 */
const TREE_STRIDE = 16;

export function spawnBoundaryEntities(
  world: World,
  kindBuffer: Uint16Array,
  content: ContentStore,
  groundHeightAt: (x: number, y: number) => number,
): { trees: number } {
  let trees = 0;

  for (let y = TREE_STRIDE / 2; y < TILE_SIZE; y += TREE_STRIDE) {
    for (let x = TREE_STRIDE / 2; x < TILE_SIZE; x += TREE_STRIDE) {
      const idx = y * TILE_SIZE + x;
      if (kindBuffer[idx] !== BOUNDARY_KIND_VEGETATION) continue;
      const z = groundHeightAt(x, y);
      spawnPrefab(world, content, "tree", { x, y, z });
      trees++;
    }
  }

  return { trees };
}
