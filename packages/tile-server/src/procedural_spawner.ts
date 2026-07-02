/**
 * Procedural world population — replays the explicit entity/NPC lists from
 * `tile_layout.json`.
 *
 * Extracted from TileServer so server.ts can stay focused on tick-loop
 * orchestration and session lifecycle. Everything in here is deterministic:
 * the same (tileSeed, content, layout) produces the same spawns, so world
 * state survives restarts without needing to persist NPCs.
 *
 * `spawnInitialEntities` is for entities that ARE persisted (resource nodes,
 * workstations). `spawnInitialNpcs` always runs on startup since NPCs are
 * not persisted.
 */
import type { World } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import { Heightmap } from "@voxim/world";
import { spawnPrefab } from "./spawner.ts";
import { TraderInventory } from "./components/trader.ts";

const CHUNK_CELLS = 32;

/** Deterministic position-based seed — same (x,y) always gives same visual/hitbox variation. */
export function positionSeed(x: number, y: number): number {
  return ((Math.imul(x * 100 | 0, 0x45d9f3b) ^ Math.imul(y * 100 | 0, 0x119de1f3)) >>> 0);
}

/**
 * Build a cached (chunkX,chunkY) → heightmap lookup from the world, used for
 * placing props on the terrain surface. Returns a getter that reads height at
 * arbitrary world (x, y), defaulting to 4.0 when no chunk covers that cell.
 */
function buildTerrainHeightLookup(world: World): (wx: number, wy: number) => number {
  const heightChunks = new Map<string, Float32Array>();
  for (const { heightmap } of world.query(Heightmap)) {
    heightChunks.set(`${heightmap.chunkX},${heightmap.chunkY}`, heightmap.data);
  }
  return (wx: number, wy: number) => {
    const cx = Math.floor(wx / CHUNK_CELLS);
    const cy = Math.floor(wy / CHUNK_CELLS);
    const data = heightChunks.get(`${cx},${cy}`);
    if (!data) return 4.0;
    const lx = Math.min(CHUNK_CELLS - 1, Math.floor(wx) - cx * CHUNK_CELLS);
    const ly = Math.min(CHUNK_CELLS - 1, Math.floor(wy) - cy * CHUNK_CELLS);
    return data[lx + ly * CHUNK_CELLS];
  };
}

export class ProceduralSpawner {
  constructor(
    private readonly world: World,
    private readonly content: ContentService,
    private readonly tileSeed: number,
  ) {}

  /**
   * Spawn persistent world entities (resource nodes, workstations) from
   * tile_layout.json. Only called on fresh world — these entities are saved
   * and reloaded. No-ops when no layout file is present.
   */
  spawnInitialEntities(): void {
    const layout = this.content.getTileLayout();
    if (!layout) return;
    // Snap structural props to the actual terrain surface — they have no
    // physics to settle them (unlike NPCs, which gravity drops to groundZ),
    // so a stale hardcoded z floats them. An explicit cfg.z still wins if a
    // layout deliberately pins one.
    const getTerrainZ = buildTerrainHeightLookup(this.world);
    let spawned = 0;
    for (const cfg of layout.entities) {
      if (!this.content.prefabs.get(cfg.prefabId)) {
        console.warn(`[ProceduralSpawner] unknown prefab "${cfg.prefabId}"`);
        continue;
      }
      spawnPrefab(this.world, this.content, cfg.prefabId, {
        x: cfg.x, y: cfg.y, z: cfg.z ?? getTerrainZ(cfg.x, cfg.y),
        seed: positionSeed(cfg.x, cfg.y),
      });
      spawned++;
    }
    console.log(`[ProceduralSpawner] spawned ${spawned} entities from tile_layout`);
  }

  /**
   * Spawn NPCs from tile_layout.json.
   * Always called — NPCs are not persisted across restarts. No-ops when no
   * layout file is present.
   */
  spawnInitialNpcs(): void {
    const layout = this.content.getTileLayout();
    if (!layout) return;
    for (const cfg of layout.npcs) {
      if (!this.content.prefabs.get(cfg.prefabId)) {
        console.warn(`[ProceduralSpawner] unknown prefab "${cfg.prefabId}"`);
        continue;
      }
      const id = spawnPrefab(this.world, this.content, cfg.prefabId, {
        x: cfg.x, y: cfg.y,
        instanceName: cfg.name,
      });
      if (cfg.traderListings?.length) {
        this.world.write(id, TraderInventory, { listings: cfg.traderListings });
      }
    }
    console.log(`[ProceduralSpawner] spawned ${layout.npcs.length} NPCs from tile_layout`);
  }
}
