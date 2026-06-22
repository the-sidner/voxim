/**
 * ChunkLifecycleSystem (T-064) — dynamic terrain streaming by entity proximity.
 *
 * An idle tile far from any player or NPC should cost nothing. Each tick this
 * system checks every loaded chunk against the positions of all active
 * (Position-bearing) entities: a chunk within `world.chunkLoadRadiusMultiplier
 * × network.aoiRadius` of any anchor stays loaded; one out of range for longer
 * than `world.chunkUnloadGraceTicks` is cached in memory and destroyed; a
 * cached chunk that comes back into range is recreated verbatim from the cache.
 *
 * Caching before destroy is the data-safety contract: a chunk that was dug,
 * built on, or POI-stamped is preserved byte-for-byte and restored unchanged.
 * Chunks never unload while terrain is near gameplay — the load radius is a
 * config multiple of the AoI radius (≥ what any client sees), and the grace is
 * long, so the unload edge is far from the player.
 *
 * The pure load/unload verdict lives in `chunk_lifecycle_decision.ts` so it can
 * be unit-tested without a World; this system only queries, applies the verdict
 * (cache + destroy / recreate), and owns the cache + grace-counter maps.
 *
 * Registered LATE in the pipeline (after PhysicsSystem) so it reads positions
 * committed earlier this tick rather than last tick's stale ones.
 */
import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import {
  Heightmap, MaterialGrid, OpenMask, KindGrid,
  type HeightmapData, type MaterialGridData, type OpenMaskData, type KindGridData,
} from "@voxim/world";
import type { System, EventEmitter } from "../system.ts";
import { Position } from "../components/game.ts";
import {
  chunkKey, decideChunkLifecycle,
  type Anchor, type ChunkCoord,
} from "./chunk_lifecycle_decision.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ChunkLifecycleSystem");

/** Serialized terrain state for an unloaded chunk, restored verbatim on reload. */
interface CachedChunk {
  heightmap: HeightmapData;
  materialGrid: MaterialGridData;
  openMask: OpenMaskData;
  kindGrid: KindGridData;
}

export class ChunkLifecycleSystem implements System {
  /** Runs after physics so anchor positions are this tick's, not last tick's. */
  readonly dependsOn = ["PhysicsSystem"];

  /** Terrain of unloaded chunks, keyed by `chunkKey`. Survives until reload. */
  private readonly cache = new Map<string, CachedChunk>();
  /** Per-loaded-chunk out-of-range tick counter, keyed by `chunkKey`. */
  private readonly grace = new Map<string, number>();

  constructor(private readonly content: ContentService) {}

  run(world: World, _events: EventEmitter, _dt: number): void {
    const cfg = this.content.getGameConfig();
    const loadRadius = cfg.network.aoiRadius * cfg.world.chunkLoadRadiusMultiplier;
    const unloadGraceTicks = cfg.world.chunkUnloadGraceTicks;

    // Anchors: every active entity (players, NPCs, dropped items, projectiles,
    // gates) keeps nearby terrain loaded. Chunks carry no Position, so this
    // query never includes the terrain it gates.
    const anchors: Anchor[] = [];
    for (const { position } of world.query(Position)) {
      anchors.push({ x: position.x, y: position.y });
    }

    // Loaded chunks + a coord→entity lookup so the unload pass can destroy them.
    const loaded: ChunkCoord[] = [];
    const entityByKey = new Map<string, EntityId>();
    for (const { entityId, heightmap } of world.query(Heightmap)) {
      const coord = { chunkX: heightmap.chunkX, chunkY: heightmap.chunkY };
      loaded.push(coord);
      entityByKey.set(chunkKey(coord.chunkX, coord.chunkY), entityId);
    }

    const cachedKeys = new Set(this.cache.keys());
    const { toUnload, toLoad } = decideChunkLifecycle(
      loaded, cachedKeys, anchors, this.grace,
      { loadRadius, unloadGraceTicks },
    );

    // ── Unload: cache the chunk's full grid set, then destroy the entity. ──
    for (const { chunkX, chunkY } of toUnload) {
      const key = chunkKey(chunkX, chunkY);
      const id = entityByKey.get(key);
      if (!id) continue; // defensive — decision only names loaded chunks
      const cached = this.snapshot(world, id);
      if (!cached) {
        // A chunk missing a grid component can't be restored intact — keep it
        // loaded rather than risk losing terrain (matches SaveManager's
        // "full grid set matters" stance).
        log.warn("skip unload of chunk %d,%d: incomplete grid set", chunkX, chunkY);
        continue;
      }
      this.cache.set(key, cached);
      world.destroy(id); // deferred; purged on applyChangeset
    }

    // ── Load: recreate cached chunks back within range, verbatim. ──
    for (const { chunkX, chunkY } of toLoad) {
      const key = chunkKey(chunkX, chunkY);
      const cached = this.cache.get(key);
      if (!cached) continue; // defensive — decision only names cached chunks
      this.restore(world, cached);
      this.cache.delete(key);
    }

    if (toUnload.length || toLoad.length) {
      log.debug("loaded=%d cached=%d unloaded=%d reloaded=%d",
        loaded.length, this.cache.size, toUnload.length, toLoad.length);
    }
  }

  /** Deep-copy a chunk's four grid components, or null if any is missing. */
  private snapshot(world: World, id: EntityId): CachedChunk | null {
    const hm = world.get(id, Heightmap);
    const mg = world.get(id, MaterialGrid);
    const om = world.get(id, OpenMask);
    const kg = world.get(id, KindGrid);
    if (!hm || !mg || !om || !kg) return null;
    return {
      heightmap: { data: hm.data.slice(), chunkX: hm.chunkX, chunkY: hm.chunkY },
      materialGrid: { data: mg.data.slice() },
      openMask: { data: om.data.slice() },
      kindGrid: { data: kg.data.slice() },
    };
  }

  /** Recreate a chunk entity from cached terrain via immediate writes. */
  private restore(world: World, cached: CachedChunk): void {
    const id = newEntityId();
    world.create(id);
    // Copy again on write so a later reload of the same coord can't alias the
    // live component arrays (the cache entry is deleted by the caller anyway,
    // but keep restore self-contained).
    world.write(id, Heightmap, {
      data: cached.heightmap.data.slice(),
      chunkX: cached.heightmap.chunkX,
      chunkY: cached.heightmap.chunkY,
    });
    world.write(id, MaterialGrid, { data: cached.materialGrid.data.slice() });
    world.write(id, OpenMask, { data: cached.openMask.data.slice() });
    world.write(id, KindGrid, { data: cached.kindGrid.data.slice() });
  }

  /** Test/diagnostics: number of chunks currently held in the unload cache. */
  cachedCount(): number {
    return this.cache.size;
  }
}
