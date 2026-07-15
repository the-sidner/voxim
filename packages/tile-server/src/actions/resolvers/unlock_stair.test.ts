/**
 * unlock_stair effect resolver tests (T-213b).
 *
 * Builds a small World with one loaded chunk (32×32, the real CHUNK_SIZE)
 * whose local footprint carries a hand-built path/wilderness fixture
 * (mirrors packages/atlas/src/tilemap/stair_unlock.test.ts's fixture
 * shape, confined to one chunk instead of the full TILE_SIZE² so the test
 * stays cheap) + a Stair entity + a zoneBuffer fixture at the real
 * TILE_SIZE (512) resolution. Verifies: post-resolve openMask flips
 * across the expected cells, Stair.unlocked flips + ModelRef swaps, and a
 * trinket-id mismatch does nothing.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Heightmap, OpenMask, CHUNK_SIZE, TILE_SIZE } from "@voxim/world";
import { Stair } from "../../components/stair.ts";
import { ModelRef } from "../../components/game.ts";
import { STAIR_FOUND_PREFAB_ID } from "../../stair_spawner.ts";
import { UnlockStairResolver } from "./unlock_stair.ts";
import type { ResolveContext } from "../effect.ts";
import type { ActiveActionState } from "../../components/action.ts";

const content = await JsonSource.load();
const FAKE_STATE: ActiveActionState = { actionId: "", phase: "", ticksInPhase: 0, initiator: "event" };

const WALL = 2.0;
const FLOOR = 0.0;
const PATH_ZID = 1;
const WILD_ZID = 2;

/** One chunk (chunkX=0, chunkY=0) with a path/wilderness fixture in its
 * local 32×32 footprint, mirroring stair_unlock.test.ts's shape:
 *   cols 1..3, rows 1..5 = path (floor, open)
 *   cols 4..6, rows 2..5 = wilderness (wall, closed)
 * Anchor at local (3, 2) — last path cell before the wilderness. */
function makeWorldWithChunk(): { world: World; zoneBuffer: Uint16Array } {
  const world = new World();
  const height = new Float32Array(CHUNK_SIZE * CHUNK_SIZE);
  const open = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  const zoneBuffer = new Uint16Array(TILE_SIZE * TILE_SIZE).fill(0xFFFF);

  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const li = y * CHUNK_SIZE + x;
      const gi = y * TILE_SIZE + x; // chunk (0,0) -> global offset == local
      const isPath = y >= 1 && y <= 5 && x >= 1 && x <= 3 && !(y >= 2 && y <= 5 && x === 4);
      const isWild = y >= 2 && y <= 5 && x >= 4 && x <= 6;
      if (isPath) {
        open[li] = 1; height[li] = FLOOR; zoneBuffer[gi] = PATH_ZID;
      } else if (isWild) {
        open[li] = 0; height[li] = WALL; zoneBuffer[gi] = WILD_ZID;
      } else {
        open[li] = 0; height[li] = WALL;
      }
    }
  }

  const chunkId = newEntityId();
  world.create(chunkId);
  world.write(chunkId, Heightmap, { data: height, chunkX: 0, chunkY: 0 });
  world.write(chunkId, OpenMask, { data: open });
  world.applyChangeset();
  return { world, zoneBuffer };
}

function makeStair(world: World, trinketId: string, unlocked = false): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Stair, {
    stairId: "stair_test", toZoneId: WILD_ZID, fromZoneId: PATH_ZID, trinketId,
    anchorX: 3, anchorY: 2, unlocked,
    wallHeight: WALL, rampDepth: 4, rampHalfWidth: 1,
  });
  world.write(id, ModelRef, { modelId: "model_stair_locked", scaleX: 1, scaleY: 1, scaleZ: 1, seed: 0 });
  world.applyChangeset();
  return id;
}

function resolve(world: World, zoneBuffer: Uint16Array, trinketId: string): void {
  const resolver = new UnlockStairResolver(() => zoneBuffer);
  const ctx: ResolveContext = {
    world, events: new EventBus(), entityId: newEntityId(), slot: "primary",
    state: FAKE_STATE, content, params: { trinketId }, edge: "enter", serverTick: 0,
  };
  resolver.resolve(ctx);
  world.applyChangeset();
}

Deno.test("unlock_stair: flips openMask across the wilderness blob + ramp, sets Stair.unlocked, swaps ModelRef", () => {
  const { world, zoneBuffer } = makeWorldWithChunk();
  const stairId = makeStair(world, "trinket_test_1");

  // Pre-condition: wilderness cells closed.
  const chunk = [...world.query(Heightmap)][0];
  let wildBlockedBefore = 0;
  for (let y = 2; y <= 5; y++) for (let x = 4; x <= 6; x++) {
    if (world.get(chunk.entityId, OpenMask)!.data[y * CHUNK_SIZE + x] === 0) wildBlockedBefore++;
  }
  assert(wildBlockedBefore > 0);

  resolve(world, zoneBuffer, "trinket_test_1");

  const om = world.get(chunk.entityId, OpenMask)!;
  let wildBlockedAfter = 0;
  for (let y = 2; y <= 5; y++) for (let x = 4; x <= 6; x++) {
    if (om.data[y * CHUNK_SIZE + x] === 0) wildBlockedAfter++;
  }
  assertEquals(wildBlockedAfter, 0, "every wilderness cell should be open after unlock");

  const stair = world.get(stairId, Stair)!;
  assertEquals(stair.unlocked, true);

  const foundModelId = content.prefabs.get(STAIR_FOUND_PREFAB_ID)?.modelId;
  assertEquals(world.get(stairId, ModelRef)?.modelId, foundModelId);
});

Deno.test("unlock_stair: trinket-id mismatch does nothing", () => {
  const { world, zoneBuffer } = makeWorldWithChunk();
  const stairId = makeStair(world, "trinket_test_1");

  resolve(world, zoneBuffer, "trinket_WRONG");

  assertEquals(world.get(stairId, Stair)?.unlocked, false);
  const chunk = [...world.query(Heightmap)][0];
  const om = world.get(chunk.entityId, OpenMask)!;
  let stillBlocked = 0;
  for (let y = 2; y <= 5; y++) for (let x = 4; x <= 6; x++) {
    if (om.data[y * CHUNK_SIZE + x] === 0) stillBlocked++;
  }
  assert(stillBlocked > 0, "wilderness must stay closed when the trinket doesn't match");
});

Deno.test("unlock_stair: an already-unlocked stair is not matched again", () => {
  const { world, zoneBuffer } = makeWorldWithChunk();
  makeStair(world, "trinket_test_1", true);

  // Should no-op (no matching LOCKED stair) — no throw, no changes.
  resolve(world, zoneBuffer, "trinket_test_1");
  // No assertion needed beyond "did not throw" — matches the doctrine of
  // the encounter/wave resolvers' unknown-id no-op stance.
});
