/**
 * Pure lifecycle decision for dynamic chunk streaming (T-064).
 *
 * Given the current set of loaded chunks, a set of chunks that exist only in
 * the unload cache, the positions of every active (Position-bearing) entity,
 * and the load radius + grace, decide which chunks to *load* (recreate within
 * range) and which to *unload* (cache + destroy, out of range past grace).
 *
 * Kept free of World/ECS access so the decision is unit-testable in isolation
 * from terrain entities — the system feeds it coords + positions and applies
 * the verdict (`ChunkLifecycleSystem`).
 *
 * Conservative by construction: a chunk is "in range" if ANY anchor is within
 * `loadRadius` of the chunk's centre, so terrain under or near gameplay never
 * unloads. The grace counter only advances while a chunk is out of range of
 * every anchor; one anchor stepping back into range resets it to 0.
 */
import { CHUNK_SIZE } from "@voxim/world";

export interface ChunkCoord {
  chunkX: number;
  chunkY: number;
}

export interface Anchor {
  x: number;
  y: number;
}

export interface LifecycleConfig {
  /** World-unit radius around an anchor within which chunks stay loaded. */
  loadRadius: number;
  /** Ticks out-of-range before a loaded chunk unloads. */
  unloadGraceTicks: number;
}

export interface LifecycleDecision {
  /** Loaded chunks to cache + destroy this tick. */
  toUnload: ChunkCoord[];
  /** Cached chunks to recreate this tick (back within an anchor's range). */
  toLoad: ChunkCoord[];
}

/** Stable map key for a chunk coordinate. */
export function chunkKey(chunkX: number, chunkY: number): string {
  return `${chunkX},${chunkY}`;
}

/** Centre of a chunk in world units. */
function chunkCentre(chunkX: number, chunkY: number): { x: number; y: number } {
  return { x: (chunkX + 0.5) * CHUNK_SIZE, y: (chunkY + 0.5) * CHUNK_SIZE };
}

/** True if any anchor is within `loadRadius` of the chunk's centre. */
function inRange(chunkX: number, chunkY: number, anchors: readonly Anchor[], loadRadius: number): boolean {
  const c = chunkCentre(chunkX, chunkY);
  const r2 = loadRadius * loadRadius;
  for (const a of anchors) {
    const dx = a.x - c.x;
    const dy = a.y - c.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

/**
 * Decide chunk loads/unloads for this tick. Mutates `grace` in place: resets
 * in-range loaded chunks to 0, advances out-of-range ones, and drops entries
 * for chunks queued to unload (the system stops tracking them once destroyed).
 *
 * @param loaded   coords of every chunk entity currently in the world
 * @param cached   keys (`chunkKey`) of chunks present only in the unload cache
 * @param anchors  positions of active entities that keep terrain loaded
 * @param grace    per-loaded-chunk out-of-range tick counter (mutated)
 */
export function decideChunkLifecycle(
  loaded: readonly ChunkCoord[],
  cached: ReadonlySet<string>,
  anchors: readonly Anchor[],
  grace: Map<string, number>,
  config: LifecycleConfig,
): LifecycleDecision {
  const toUnload: ChunkCoord[] = [];
  const toLoad: ChunkCoord[] = [];

  // ── Unload pass: loaded chunks out of range past their grace window. ──
  const loadedKeys = new Set<string>();
  for (const { chunkX, chunkY } of loaded) {
    const key = chunkKey(chunkX, chunkY);
    loadedKeys.add(key);

    if (inRange(chunkX, chunkY, anchors, config.loadRadius)) {
      grace.set(key, 0);
      continue;
    }

    const next = (grace.get(key) ?? 0) + 1;
    if (next > config.unloadGraceTicks) {
      toUnload.push({ chunkX, chunkY });
      grace.delete(key);
    } else {
      grace.set(key, next);
    }
  }

  // Prune grace entries for chunks no longer loaded (already unloaded / never
  // re-tracked) so the map can't grow unbounded across reload cycles.
  for (const key of grace.keys()) {
    if (!loadedKeys.has(key)) grace.delete(key);
  }

  // ── Load pass: cached chunks that came back within an anchor's range. ──
  for (const key of cached) {
    const comma = key.indexOf(",");
    const chunkX = Number(key.slice(0, comma));
    const chunkY = Number(key.slice(comma + 1));
    if (inRange(chunkX, chunkY, anchors, config.loadRadius)) {
      toLoad.push({ chunkX, chunkY });
    }
  }

  return { toUnload, toLoad };
}
