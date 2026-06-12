/**
 * TileOrchestrator — the gateway's view of which tiles are running.
 *
 * Wraps TileRepo (DB-backed registry) + TileSpawner (how to bring up a
 * tile-server when needed). Today the spawner is a no-op stub; once
 * dynamic spawn is implemented (DockerSocketSpawner / K8sSpawner) the
 * gateway can synthesize tile-servers on demand.
 *
 * Eviction discipline:
 *   - Tiles upsert via `register()` on startup, and bump their entry via
 *     `heartbeat()` every ~10s.
 *   - A periodic `evictStale()` sweep removes rows whose
 *     last_heartbeat_at is older than the TTL (default 30s).
 *   - A tile that has been evicted but is still alive will re-register
 *     when its next heartbeat returns `{ known: false }`.
 */
import type { TileRepo, TileRow } from "@voxim/db";

/**
 * Strategy for bringing up a tile-server when the gateway needs one that
 * isn't registered. Today this is a stub — tile-servers are started by
 * compose. Future implementations will shell out to docker / k8s.
 */
export interface TileSpawner {
  /**
   * Asked to bring up a tile-server for `tileId`. Returns when the tile is
   * registered with the orchestrator and ready to accept connections.
   * Throws if it can't (no capacity, unknown spawner backend, etc.).
   */
  spawn(tileId: string): Promise<void>;
}

/** Default spawner — until T-141 wires up DockerSocketSpawner. */
export class NoopSpawner implements TileSpawner {
  async spawn(tileId: string): Promise<void> {
    throw new Error(`NoopSpawner: cannot spawn tile "${tileId}" — dynamic tile spawning is not implemented`);
  }
}

export interface TileOrchestratorConfig {
  repo: TileRepo;
  spawner: TileSpawner;
  /** Seconds without a heartbeat before a tile is evicted. Default 30. */
  staleAfterSeconds?: number;
  /** How often to sweep the registry for evictions, in seconds. Default 10. */
  sweepIntervalSeconds?: number;
}

export class TileOrchestrator {
  private readonly repo: TileRepo;
  private readonly spawner: TileSpawner;
  private readonly staleAfterMs: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: TileOrchestratorConfig) {
    this.repo = config.repo;
    this.spawner = config.spawner;
    this.staleAfterMs = (config.staleAfterSeconds ?? 30) * 1000;
    this.sweepIntervalMs = (config.sweepIntervalSeconds ?? 10) * 1000;
  }

  startSweepLoop(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweepOnce(), this.sweepIntervalMs);
  }

  stopSweepLoop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** One eviction pass — exposed for tests / explicit triggers. */
  async sweepOnce(): Promise<string[]> {
    const cutoff = new Date(Date.now() - this.staleAfterMs);
    try {
      const evicted = await this.repo.evictStale(cutoff);
      for (const id of evicted) {
        console.log(`[TileOrchestrator] evicted stale tile ${id}`);
      }
      return evicted;
    } catch (err) {
      console.error("[TileOrchestrator] sweep error:", err);
      return [];
    }
  }

  async register(input: { tileId: string; address: string; adminUrl: string }): Promise<void> {
    await this.repo.upsert(input);
    console.log(`[TileOrchestrator] registered tile ${input.tileId} at ${input.address}`);
  }

  async deregister(tileId: string): Promise<void> {
    await this.repo.delete(tileId);
    console.log(`[TileOrchestrator] deregistered tile ${tileId}`);
  }

  /**
   * Bump a tile's last-heartbeat. Returns false if the tile isn't in the
   * registry — caller (tile-server) must re-register.
   */
  async heartbeat(tileId: string): Promise<boolean> {
    return await this.repo.heartbeat(tileId);
  }

  async get(tileId: string): Promise<TileRow | null> {
    return await this.repo.get(tileId);
  }

  async list(): Promise<TileRow[]> {
    return await this.repo.list();
  }

  /**
   * Pick the tile a user should connect to. Returns null if no tiles are
   * registered (caller may want to invoke `spawner.spawn()` in that case
   * — gateway today treats it as 503).
   */
  async tileFor(userId: string, lastTileId: string | null): Promise<TileRow | null> {
    if (lastTileId) {
      const preferred = await this.repo.get(lastTileId);
      if (preferred) return preferred;
    }
    const tiles = await this.repo.list();
    if (tiles.length === 0) return null;
    // Stable ordering — repo.list() already returns sorted by tile_id.
    // Pick deterministically by hashing userId so two players don't both
    // pile onto tile_0 if tile_1+ are also free. For one-tile dev the
    // result is unchanged.
    return tiles[hashUserId(userId) % tiles.length];
  }
}

function hashUserId(userId: string): number {
  let h = 5381;
  for (let i = 0; i < userId.length; i++) h = ((h << 5) + h + userId.charCodeAt(i)) | 0;
  return Math.abs(h);
}
