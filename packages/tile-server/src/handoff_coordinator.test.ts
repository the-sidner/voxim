/**
 * HandoffCoordinator: freeze-on-initiation + single-teardown-path (T-361).
 *
 * initiateHandoff builds the payload as a SNAPSHOT — so it must neutralise
 * the player's InputState (stale held movement/actions would replay every
 * tick of the gateway round-trip) and, on success, exit through the one
 * "player leaves this tile" path (deps.teardownSession with handedOff)
 * instead of a bespoke destroy+delete sibling. On failure the player stays
 * — no teardown.
 */

import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import { HandoffCoordinator, type HandoffCoordinatorDeps } from "./handoff_coordinator.ts";
import { Position, InputState } from "./components/game.ts";
import type { ClientSession } from "./session.ts";
import type { TickLoop } from "./tick_loop.ts";
import { EventBus } from "@voxim/engine";

function makeDeps(world: World, teardownCalls: Array<{ id: EntityId; handedOff: boolean }>): HandoffCoordinatorDeps {
  return {
    world,
    eventBus: new EventBus(),
    sessions: new Map<EntityId, ClientSession>(),
    tickLoop: { currentTick: 0 } as TickLoop,
    tileId: "0_0",
    serviceSecret: "0123456789abcdef",
    zoneBuffer: null,
    zoneById: new Map(),
    getGatewayUrl: () => "http://gateway.test",
    getGatewayLink: () => null,
    getEvents: () => {
      throw new Error("not used by initiateHandoff");
    },
    teardownSession: (id, opts) => {
      teardownCalls.push({ id, handedOff: opts.handedOff });
      return Promise.resolve();
    },
  };
}

function spawnBarePlayer(world: World): EntityId {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x: 10, y: 10, z: 4 });
  world.write(id, InputState, {
    facing: 1.5, pitch: 0, movementX: 1, movementY: -1,
    actions: 0b1011, chargeMs: 120, seq: 42, timestamp: 0, rttMs: 50,
  });
  return id;
}

function withFetchStub(response: () => Promise<Response>, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => response()) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const flush = () => new Promise((r) => setTimeout(r, 10));

Deno.test("initiateHandoff neutralises InputState synchronously (freeze) but keeps facing/seq", async () => {
  await withFetchStub(() => Promise.resolve(Response.json({})), async () => {
    const world = new World();
    const playerId = spawnBarePlayer(world);
    const coordinator = new HandoffCoordinator(makeDeps(world, []));

    coordinator.initiateHandoff({ entityId: playerId, gateId: "gate-1", destinationTileId: "1_0" });

    const input = world.get(playerId, InputState)!;
    assertEquals(input.movementX, 0, "held movement cleared");
    assertEquals(input.movementY, 0);
    assertEquals(input.actions, 0, "stale action bits cleared");
    assertEquals(input.chargeMs, 0);
    assertEquals(input.facing, 1.5, "facing preserved");
    assertEquals(input.seq, 42, "seq preserved — reconnect ack stays monotonic");
    assert(coordinator.isHandingOff(playerId), "drain-skip guard is up");
    await flush();
  });
});

Deno.test("success path exits through teardownSession(handedOff) — no bespoke destroy", async () => {
  await withFetchStub(() => Promise.resolve(Response.json({ destinationTileAddress: "" })), async () => {
    const world = new World();
    const playerId = spawnBarePlayer(world);
    const teardownCalls: Array<{ id: EntityId; handedOff: boolean }> = [];
    const coordinator = new HandoffCoordinator(makeDeps(world, teardownCalls));

    coordinator.initiateHandoff({ entityId: playerId, gateId: "gate-1", destinationTileId: "1_0" });
    await flush();

    assertEquals(teardownCalls, [{ id: playerId, handedOff: true }], "one teardown, handedOff");
    assert(world.isAlive(playerId), "coordinator itself no longer destroys — teardown owns that");
    assertFalse(coordinator.isHandingOff(playerId), "guard cleared after settle");
  });
});

Deno.test("failed handoff never tears down — the player stays on this tile", async () => {
  await withFetchStub(() => Promise.resolve(new Response("boom", { status: 502 })), async () => {
    const world = new World();
    const playerId = spawnBarePlayer(world);
    const teardownCalls: Array<{ id: EntityId; handedOff: boolean }> = [];
    const coordinator = new HandoffCoordinator(makeDeps(world, teardownCalls));

    coordinator.initiateHandoff({ entityId: playerId, gateId: "gate-1", destinationTileId: "1_0" });
    await flush();

    assertEquals(teardownCalls.length, 0);
    assert(world.isAlive(playerId));
    assertFalse(coordinator.isHandingOff(playerId), "guard cleared so play resumes");
  });
});
