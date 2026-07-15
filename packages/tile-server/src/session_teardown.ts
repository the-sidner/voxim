/**
 * teardownPlayer — the single "player leaves this tile" path (T-354,
 * hardened T-361). Three callers, one shape:
 *
 *   - the tick loop's dead-session sweep          (disconnect noticed by tick)
 *   - handleSession's end-of-session continuation (disconnect noticed by read)
 *   - the handoff success continuation            (`handedOff: true`)
 *
 * Two-phase BY CONTRACT — everything that touches the world or a per-player
 * map runs SYNCHRONOUSLY before the first await:
 *
 *   1. Sync: session-map delete, per-player cache clears, fog-bitmap
 *      snapshot, entity + carried-item destroy. A reconnect landing
 *      mid-teardown therefore always observes a dead entity and empty
 *      caches and takes the fresh-spawn path — there is no window where
 *      handleSession can revive-then-lose the entity, and a hung account
 *      service can never leave a disconnected player's body standing in
 *      the world.
 *   2. Async: account-service bookkeeping only (fog save, then location
 *      update or death record). Never touches the world. `handedOff`
 *      skips the location/death branch entirely — the destination tile
 *      owns both from the moment the handoff was acked; recording either
 *      here would advance a dynasty generation (or rewrite last_tile_id)
 *      for a player who merely crossed a gate.
 */
import type { EntityId, World } from "@voxim/engine";
import { FogState } from "./components/fog_state.ts";
import { destroyCarriedItemEntities } from "./spawner.ts";

/** The slice of AccountClient teardown needs (narrow so tests can fake it). */
export interface TeardownAccountOps {
  saveFog(userId: string, tileId: string, bitmap: Uint8Array): Promise<void>;
  updateLocation(userId: string, lastTileId: string): Promise<void>;
  recordDeath(userId: string, cause: "damage" | "starvation" | "effect", killerId?: string): Promise<void>;
}

export interface TeardownDeps {
  world: World;
  sessions: Map<EntityId, unknown>;
  accountClient: TeardownAccountOps | null;
  tileId: string;
  /**
   * Synchronous per-player cache clears owned by the caller: last-seen zone,
   * hearth anchor, display name, resolved character. Runs in the sync phase
   * so a rejoin never resurrects a previous life's cached selections.
   */
  clearPlayerCaches: (playerId: EntityId) => void;
}

export async function teardownPlayer(
  deps: TeardownDeps,
  playerId: EntityId,
  opts: { handedOff?: boolean } = {},
): Promise<void> {
  // ── Phase 1: synchronous — world + maps are consistent before any await.
  deps.sessions.delete(playerId);
  deps.clearPlayerCaches(playerId);
  // Snapshot the fog bitmap BEFORE the destroy drops FogState with the entity.
  const fogBytes = deps.accountClient
    ? deps.world.get(playerId, FogState)?.seenEver.slice() ?? null
    : null;
  const wasAlive = deps.world.isAlive(playerId);
  if (wasAlive) {
    // T-252: take the carried item entities along — players respawn fresh
    // (save doctrine), so leaving them would leak forever.
    // T-219: destroySubtree also takes the bone-entity subtree (and any
    // scene-graph-parented equipment on it) along.
    destroyCarriedItemEntities(deps.world, playerId);
    deps.world.destroySubtree(playerId);
  }

  // ── Phase 2: async — account-service bookkeeping. Best-effort: errors log
  // but never block cleanup (which already happened above).
  if (deps.accountClient && fogBytes) {
    // Persist fog of war (T-161) — under THIS tile's key, for a handoff too:
    // the payload no longer carries fog (T-361), so this save is the only
    // record of what the player explored here.
    await deps.accountClient.saveFog(playerId, deps.tileId, fogBytes).catch((err: unknown) => {
      console.error("[TileServer] fog save failed:", err);
    });
  }
  if (opts.handedOff) {
    console.log(`[TileServer] player ${playerId.slice(0, 8)} handed off (no death recorded)`);
    return;
  }
  if (deps.accountClient) {
    if (wasAlive) {
      // Clean disconnect — tell the account service which tile the player
      // last occupied so the next login routes back here.
      await deps.accountClient.updateLocation(playerId, deps.tileId).catch((err: unknown) => {
        console.error("[TileServer] updateLocation failed:", err);
      });
    } else {
      // Entity gone → combat death already destroyed it; inform the account
      // service so heritage advances a generation.
      await deps.accountClient.recordDeath(playerId, "damage").catch((err: unknown) => {
        console.error("[TileServer] recordDeath failed:", err);
      });
    }
  }
  console.log(`[TileServer] player ${playerId.slice(0, 8)} disconnected`);
}
