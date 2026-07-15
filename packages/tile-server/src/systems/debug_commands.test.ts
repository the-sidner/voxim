/**
 * DebugCommandSystem — T-327's two new commands: DebugSpawnDummy and
 * DebugSetActionParam. Runs against real content (game_config.json,
 * data/actions/, the new training_dummy prefabs) via JsonSource.load.
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import { Position, Facing } from "../components/game.ts";
import { TrainingDummy } from "../components/training_dummy.ts";
import { Inventory } from "../components/items.ts";
import { Stair } from "../components/stair.ts";
import { DebugCommandSystem } from "./debug_commands.ts";
import type { TickContext } from "../system.ts";

const content = await JsonSource.load();

function run(world: World, actor: string, cmd: CommandPayload, devMode = true): void {
  const sys = new DebugCommandSystem(content, devMode);
  const ctx: TickContext = {
    spatial: null as unknown as TickContext["spatial"],
    pendingCommands: new Map([[actor, [cmd]]]),
  };
  sys.prepare(0, ctx);
  sys.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
}

/**
 * Batches multiple commands (possibly for different actors) into ONE
 * DebugCommandSystem run + ONE applyChangeset — the exact same-tick shape
 * T-344 regressions need: two writers touching one entity's Inventory in
 * the same tick, both surviving the commit.
 */
function runBatch(world: World, commands: Array<[actor: string, cmd: CommandPayload]>): void {
  const sys = new DebugCommandSystem(content, true);
  const pending = new Map<string, CommandPayload[]>();
  for (const [actor, cmd] of commands) {
    const list = pending.get(actor) ?? [];
    list.push(cmd);
    pending.set(actor, list);
  }
  const ctx: TickContext = { spatial: null as unknown as TickContext["spatial"], pendingCommands: pending };
  sys.prepare(0, ctx);
  sys.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
}

function spawnPlayerAt(world: World, x: number, y: number): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x, y, z: 0 });
  world.write(id, Facing, { angle: 0 });
  return id;
}

Deno.test("DebugSpawnDummy(attackLoop=false) spawns a passive training_dummy in front of the player", () => {
  const world = new World();
  const player = spawnPlayerAt(world, 100, 100);

  run(world, player, { cmd: CommandType.DebugSpawnDummy, attackLoop: false });

  const dummies = [...world.query(TrainingDummy)];
  assertEquals(dummies.length, 1);
  const pos = world.get(dummies[0].entityId, Position);
  assertNotEquals(pos, null);
  // Spawned 3 units along the player's facing (0 rad → +X).
  assertEquals(Math.round(pos!.x), 103);
});

Deno.test("DebugSpawnDummy(attackLoop=true) spawns the attacker variant", () => {
  const world = new World();
  const player = spawnPlayerAt(world, 0, 0);

  run(world, player, { cmd: CommandType.DebugSpawnDummy, attackLoop: true });

  const dummies = [...world.query(TrainingDummy)];
  assertEquals(dummies.length, 1);
});

Deno.test("DebugSpawnDummy is a no-op when devMode is off", () => {
  const world = new World();
  const player = spawnPlayerAt(world, 0, 0);

  run(world, player, { cmd: CommandType.DebugSpawnDummy, attackLoop: false }, false);

  assertEquals([...world.query(TrainingDummy)].length, 0);
});

Deno.test("DebugSetActionParam patches an ActionDef's phase ticks in place, live", () => {
  const world = new World();
  const player = spawnPlayerAt(world, 0, 0);
  const before = content.actions.getOrThrow("swing_medium").phases["windup"].ticks;

  run(world, player, {
    cmd: CommandType.DebugSetActionParam,
    actionId: "swing_medium",
    field: "phases.windup.ticks",
    value: before + 7,
  });

  assertEquals(content.actions.getOrThrow("swing_medium").phases["windup"].ticks, before + 7);

  // Restore — content is a shared, process-wide singleton across this file's tests.
  content.actions.getOrThrow("swing_medium").phases["windup"].ticks = before;
});

Deno.test("DebugSetActionParam($config) patches a GameConfig leaf in place", () => {
  const world = new World();
  const player = spawnPlayerAt(world, 0, 0);
  const before = content.getGameConfig().combat.knockbackImpulseXY;

  run(world, player, {
    cmd: CommandType.DebugSetActionParam,
    actionId: "$config",
    field: "combat.knockbackImpulseXY",
    value: before + 2,
  });

  assertEquals(content.getGameConfig().combat.knockbackImpulseXY, before + 2);
  content.getGameConfig().combat.knockbackImpulseXY = before;
});

Deno.test("DebugSetActionParam refuses to create a new field or touch a non-numeric one", () => {
  const world = new World();
  const player = spawnPlayerAt(world, 0, 0);
  const def = content.actions.getOrThrow("swing_medium");
  const beforeKind = def.kind;

  // "kind" exists but is a string, not a number — must be refused.
  run(world, player, {
    cmd: CommandType.DebugSetActionParam,
    actionId: "swing_medium",
    field: "kind",
    value: 999,
  });
  assertEquals(content.actions.getOrThrow("swing_medium").kind, beforeKind);

  // Field doesn't exist at all — must be refused, no crash.
  run(world, player, {
    cmd: CommandType.DebugSetActionParam,
    actionId: "swing_medium",
    field: "phases.windup.notARealField",
    value: 1,
  });
  assertEquals("notARealField" in def.phases["windup"], false);
});

Deno.test("DebugSetActionParam on an unknown actionId is a no-op, no throw", () => {
  const world = new World();
  const player = spawnPlayerAt(world, 0, 0);

  run(world, player, {
    cmd: CommandType.DebugSetActionParam,
    actionId: "not_a_real_action",
    field: "hitStopTicks",
    value: 5,
  });
  // No assertion needed beyond "didn't throw" — the handler logs a warning and returns.
});

// ---- T-344: Inventory is a multi-writer component (world.mutate, not get-then-set) ----

Deno.test("T-344: two DebugGiveItem commands for one entity in one tick both survive (the literal bow+arrows bug)", () => {
  const world = new World();
  const player = spawnPlayerAt(world, 0, 0);
  world.write(player, Inventory, { slots: [], capacity: 20 });

  runBatch(world, [
    [player, { cmd: CommandType.DebugGiveItem, itemType: "wooden_bow", quantity: 1 }],
    [player, { cmd: CommandType.DebugGiveItem, itemType: "arrow", quantity: 20 }],
  ]);

  const slots = world.get(player, Inventory)!.slots;
  assertEquals(slots.length, 2, "both the bow and the arrows survived the same-tick commit");
  assert(slots.some((s) => s.kind === "stack" && s.prefabId === "wooden_bow"), "bow present");
  assert(slots.some((s) => s.kind === "stack" && s.prefabId === "arrow"), "arrows present");
});

Deno.test("T-344: DebugGiveTrinket declines cleanly when a same-tick DebugGiveItem fills the last capacity slot", () => {
  const world = new World();
  const player = spawnPlayerAt(world, 0, 0);
  world.write(player, Inventory, {
    slots: Array.from({ length: 19 }, () => ({ kind: "stack" as const, prefabId: "berries", quantity: 1 })),
    capacity: 20,
  });
  const stairId = "stair_test_t344";
  const stairEntity = newEntityId();
  world.create(stairEntity);
  world.write(stairEntity, Stair, {
    stairId, toZoneId: 1, fromZoneId: 0, trinketId: "trinket_test", anchorX: 0, anchorY: 0,
    unlocked: false, wallHeight: 0, rampDepth: 0, rampHalfWidth: 0,
  });

  runBatch(world, [
    [player, { cmd: CommandType.DebugGiveItem, itemType: "oak_wood", quantity: 1 }], // fills capacity to 20
    [player, { cmd: CommandType.DebugGiveTrinket, stairId }],
  ]);

  const slots = world.get(player, Inventory)!.slots;
  assertEquals(slots.length, 20, "exactly at capacity — the trinket recheck saw the commit-time count, not the stale 19");
  assert(!slots.some((s) => s.kind === "unique"), "the trinket (a unique slot) was correctly declined, not admitted past capacity");
});
