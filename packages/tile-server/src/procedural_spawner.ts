/**
 * Procedural world population — scatters NPCs, resource nodes, and decorative
 * props across a tile using zone-grid spawn profiles.
 *
 * Extracted from TileServer so server.ts can stay focused on tick-loop
 * orchestration and session lifecycle. Everything in here is deterministic:
 * the same (tileSeed, zoneGrid, content) produces the same spawns, so world
 * state survives restarts without needing to persist NPCs or props.
 *
 * `spawnInitialEntities` is for entities that ARE persisted (resource nodes,
 * workstations). `spawnInitialNpcs` and `spawnProceduralProps` always run on
 * startup since those entities are not persisted.
 */
import type { World } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import type { ZoneGridData } from "@voxim/world";
import { Heightmap } from "@voxim/world";
import { spawnEntity } from "./spawner.ts";
import { TraderInventory } from "./components/trader.ts";

const TILE_WORLD_SIZE = 512;
const CHUNK_CELLS = 32;

/**
 * Mulberry32 seeded PRNG — returns a function that yields [0, 1) each call.
 * Used to make procedural scatter reproducible: same tile seed → same layout.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function (): number {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic position-based seed — same (x,y) always gives same visual/hitbox variation. */
export function positionSeed(x: number, y: number): number {
  return ((Math.imul(x * 100 | 0, 0x45d9f3b) ^ Math.imul(y * 100 | 0, 0x119de1f3)) >>> 0);
}

/** Pick a key from a weight table using a single [0,1) random sample. */
function weightedPick(weights: Record<string, number>, rng: () => number): string | null {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  if (entries.length === 0) return null;
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r <= 0) return key;
  }
  return entries[entries.length - 1][0];
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
    private readonly content: ContentStore,
    private readonly zoneGrid: ZoneGridData | null,
    private readonly tileSeed: number,
  ) {}

  /**
   * Spawn persistent world entities (resource nodes, workstations) from
   * tile_layout.json. Only called on fresh world — these entities are saved
   * and reloaded. Falls back to procedural node scattering when no layout
   * file is present.
   */
  spawnInitialEntities(): void {
    const layout = this.content.getTileLayout();
    if (layout) {
      let spawned = 0;
      for (const cfg of layout.entities) {
        const template = this.content.getPrefab(cfg.prefabId);
        if (!template) {
          console.warn(`[ProceduralSpawner] unknown template "${cfg.prefabId}"`);
          continue;
        }
        spawnEntity(this.world, this.content, {
          x: cfg.x, y: cfg.y, z: cfg.z,
          template, seed: positionSeed(cfg.x, cfg.y),
        });
        spawned++;
      }
      console.log(`[ProceduralSpawner] spawned ${spawned} entities from tile_layout`);
      if (layout.proceduralNodes) this.spawnProceduralNodes();
    } else {
      this.spawnProceduralNodes();
    }
  }

  /**
   * Spawn NPCs from tile_layout.json or procedurally.
   * Always called — NPCs are not persisted across restarts.
   */
  spawnInitialNpcs(): void {
    const layout = this.content.getTileLayout();
    if (layout) {
      for (const cfg of layout.npcs) {
        const template = this.content.getPrefab(cfg.prefabId);
        if (!template) {
          console.warn(`[ProceduralSpawner] unknown template "${cfg.prefabId}"`);
          continue;
        }
        const id = spawnEntity(this.world, this.content, {
          x: cfg.x, y: cfg.y,
          template,
          instanceName: cfg.name,
        });
        if (cfg.traderListings?.length) {
          this.world.write(id, TraderInventory, { listings: cfg.traderListings });
        }
      }
      console.log(`[ProceduralSpawner] spawned ${layout.npcs.length} NPCs from tile_layout`);
      if (layout.proceduralNpcs) this.spawnProceduralNpcs();
    } else {
      this.spawnProceduralNpcs();
    }
  }

  /**
   * Procedurally scatter NPCs across the tile based on zone spawn profiles.
   * Water / Shore cells are skipped. RNG is seeded from the tile seed so
   * results are stable across server restarts.
   */
  private spawnProceduralNpcs(): void {
    if (!this.zoneGrid) return;
    const grid = this.zoneGrid;
    const cellWorldSize = TILE_WORLD_SIZE / grid.gridSize;
    const MARGIN = 1.5;
    const rng = mulberry32(this.tileSeed ^ 0xdeadbeef);
    let total = 0;

    for (let cy = 0; cy < grid.gridSize; cy++) {
      for (let cx = 0; cx < grid.gridSize; cx++) {
        const cell = grid.cells[cx + cy * grid.gridSize];
        const zone = this.content.getZone(cell.zoneId);
        if (!zone) continue;
        const totalWeight = Object.values(zone.npcWeights).reduce((s, w) => s + w, 0);
        if (totalWeight === 0) continue;

        const density = zone.npcSpawnDensity;
        const spawns = Math.floor(density) + (rng() < density % 1 ? 1 : 0);
        for (let i = 0; i < spawns; i++) {
          const wx = cx * cellWorldSize + MARGIN + rng() * (cellWorldSize - 2 * MARGIN);
          const wy = cy * cellWorldSize + MARGIN + rng() * (cellWorldSize - 2 * MARGIN);
          const npcType = weightedPick(zone.npcWeights, rng);
          if (!npcType) continue;
          const template = this.content.getPrefab(npcType);
          if (!template) continue;
          spawnEntity(this.world, this.content, { x: wx, y: wy, template });
          total++;
        }
      }
    }

    console.log(`[ProceduralSpawner] scattered ${total} NPCs from zone grid`);
  }

  /**
   * Procedurally scatter resource nodes across the tile based on zone spawn
   * profiles. Water cells are skipped.
   */
  private spawnProceduralNodes(): void {
    if (!this.zoneGrid) return;
    const getTerrainZ = buildTerrainHeightLookup(this.world);
    const grid = this.zoneGrid;
    const cellWorldSize = TILE_WORLD_SIZE / grid.gridSize;
    const MARGIN = 1.0;
    const rng = mulberry32(this.tileSeed ^ 0xcafebabe);
    let total = 0;

    for (let cy = 0; cy < grid.gridSize; cy++) {
      for (let cx = 0; cx < grid.gridSize; cx++) {
        const cell = grid.cells[cx + cy * grid.gridSize];
        const zone = this.content.getZone(cell.zoneId);
        if (!zone) continue;
        const totalWeight = Object.values(zone.entityWeights).reduce((s, w) => s + w, 0);
        if (totalWeight === 0) continue;

        const density = zone.nodeSpawnDensity;
        const spawns = Math.floor(density) + (rng() < density % 1 ? 1 : 0);
        for (let i = 0; i < spawns; i++) {
          const wx = cx * cellWorldSize + MARGIN + rng() * (cellWorldSize - 2 * MARGIN);
          const wy = cy * cellWorldSize + MARGIN + rng() * (cellWorldSize - 2 * MARGIN);
          const prefabId = weightedPick(zone.entityWeights, rng);
          if (!prefabId) continue;
          const template = this.content.getPrefab(prefabId);
          if (!template) continue;
          spawnEntity(this.world, this.content, {
            x: wx, y: wy, z: getTerrainZ(wx, wy),
            template, seed: positionSeed(wx, wy),
          });
          total++;
        }
      }
    }

    console.log(`[ProceduralSpawner] scattered ${total} resource nodes from zone grid`);
  }

  /** Procedurally scatter decorative props. Props are not persisted. */
  spawnProceduralProps(): void {
    if (!this.zoneGrid) return;
    const getTerrainZ = buildTerrainHeightLookup(this.world);
    const grid = this.zoneGrid;
    const cellWorldSize = TILE_WORLD_SIZE / grid.gridSize;
    const MARGIN = 2.0;
    const rng = mulberry32(this.tileSeed ^ 0xf00dcafe);
    let total = 0;

    for (let cy = 0; cy < grid.gridSize; cy++) {
      for (let cx = 0; cx < grid.gridSize; cx++) {
        const cell = grid.cells[cx + cy * grid.gridSize];
        const zone = this.content.getZone(cell.zoneId);
        if (!zone) continue;
        const totalWeight = Object.values(zone.propWeights).reduce((s, w) => s + w, 0);
        if (totalWeight === 0) continue;

        const density = zone.propSpawnDensity;
        const spawns = Math.floor(density) + (rng() < density % 1 ? 1 : 0);
        for (let i = 0; i < spawns; i++) {
          const wx = cx * cellWorldSize + MARGIN + rng() * (cellWorldSize - 2 * MARGIN);
          const wy = cy * cellWorldSize + MARGIN + rng() * (cellWorldSize - 2 * MARGIN);
          const propTemplateId = weightedPick(zone.propWeights, rng);
          if (!propTemplateId) continue;
          const propTemplate = this.content.getPrefab(propTemplateId);
          if (!propTemplate) continue;
          spawnEntity(this.world, this.content, {
            x: wx, y: wy, z: getTerrainZ(wx, wy),
            template: propTemplate, seed: positionSeed(wx, wy),
          });
          total++;
        }
      }
    }

    console.log(`[ProceduralSpawner] scattered ${total} props from zone grid`);
  }
}
