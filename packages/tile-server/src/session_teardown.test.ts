/**
 * teardownPlayer two-phase contract (T-361).
 *
 * Phase 1 (sync): sessions delete + cache clears + entity destroy happen
 * before the first await — a hung account service can never leave a
 * disconnected player's body in the world, and a reconnect landing during
 * the HTTP tail always sees a dead entity (no revive-then-destroy race).
 *
 * Phase 2 (async): fog saved from a pre-destroy snapshot; `handedOff` skips
 * the location/death bookkeeping (the destination tile owns both).
 */

import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import { teardownPlayer, type TeardownAccountOps } from "./session_teardown.ts";
import { FogState } from "./components/fog_state.ts";
import { FOG_GRID_BYTES } from "@voxim/protocol";

interface FakeAccount extends TeardownAccountOps {
  calls: string[];
  savedFog: Uint8Array | null;
  savedFogTileId: string | null;
}

/** Account fake whose saveFog can be made to hang forever. */
function fakeAccount(opts: { hangFogSave?: boolean } = {}): FakeAccount {
  const acc: FakeAccount = {
    calls: [],
    savedFog: null,
    savedFogTileId: null,
    saveFog(_userId, tileId, bitmap) {
      acc.calls.push("saveFog");
      acc.savedFog = bitmap;
      acc.savedFogTileId = tileId;
      return opts.hangFogSave ? new Promise<void>(() => {}) : Promise.resolve();
    },
    updateLocation() {
      acc.calls.push("updateLocation");
      return Promise.resolve();
    },
    recordDeath() {
      acc.calls.push("recordDeath");
      return Promise.resolve();
    },
  };
  return acc;
}

function playerWithFog(world: World): EntityId {
  const id = newEntityId();
  world.create(id);
  const seenEver = new Uint8Array(FOG_GRID_BYTES);
  seenEver[7] = 0x5a;
  world.write(id, FogState, { seenEver, revealedThisTick: [], pendingSnapshot: false });
  return id;
}

Deno.test("sync phase: entity destroy + map cleanup complete before any await, even when saveFog hangs forever", () => {
  const world = new World();
  const playerId = playerWithFog(world);
  const sessions = new Map<EntityId, unknown>([[playerId, {}]]);
  const cleared: EntityId[] = [];
  const account = fakeAccount({ hangFogSave: true });

  // Deliberately NOT awaited — the promise never settles (hung gateway).
  void teardownPlayer(
    { world, sessions, accountClient: account, tileId: "0_0", clearPlayerCaches: (id) => cleared.push(id) },
    playerId,
  );

  // Everything world/map-shaped already happened, synchronously.
  assertFalse(world.isAlive(playerId), "entity destroyed before the first await");
  assertFalse(sessions.has(playerId), "sessions entry deleted before the first await");
  assertEquals(cleared, [playerId], "per-player caches cleared before the first await");
  // The fog snapshot was taken BEFORE the destroy dropped FogState.
  assertEquals(account.savedFog?.[7], 0x5a, "fog snapshot pre-destroy");
});

Deno.test("handedOff: fog saved under the source tile, no location/death bookkeeping", async () => {
  const world = new World();
  const playerId = playerWithFog(world);
  const account = fakeAccount();

  await teardownPlayer(
    { world, sessions: new Map(), accountClient: account, tileId: "3_2", clearPlayerCaches: () => {} },
    playerId,
    { handedOff: true },
  );

  assertFalse(world.isAlive(playerId), "handoff teardown destroys the source copy");
  assertEquals(account.calls, ["saveFog"], "no updateLocation / recordDeath for a crossing");
  assertEquals(account.savedFogTileId, "3_2", "source-tile fog persisted under the SOURCE tile's key");
});

Deno.test("clean disconnect (alive): updateLocation, not recordDeath", async () => {
  const world = new World();
  const playerId = playerWithFog(world);
  const account = fakeAccount();

  await teardownPlayer(
    { world, sessions: new Map(), accountClient: account, tileId: "0_0", clearPlayerCaches: () => {} },
    playerId,
  );

  assertEquals(account.calls, ["saveFog", "updateLocation"]);
});

Deno.test("disconnect after combat death (entity gone): recordDeath, not updateLocation", async () => {
  const world = new World();
  const playerId = newEntityId(); // never created — already destroyed by death
  const account = fakeAccount();

  await teardownPlayer(
    { world, sessions: new Map(), accountClient: account, tileId: "0_0", clearPlayerCaches: () => {} },
    playerId,
  );

  assertEquals(account.calls, ["recordDeath"]);
});

Deno.test("no account client: fully synchronous cleanup, no throw", async () => {
  const world = new World();
  const playerId = playerWithFog(world);
  const sessions = new Map<EntityId, unknown>([[playerId, {}]]);

  await teardownPlayer(
    { world, sessions, accountClient: null, tileId: "0_0", clearPlayerCaches: () => {} },
    playerId,
  );

  assertFalse(world.isAlive(playerId));
  assert(sessions.size === 0);
});
