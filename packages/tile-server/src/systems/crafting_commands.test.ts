/**
 * CraftingSystem's player-facing commands — LoadWorkstation / TakeWorkstation
 * / PickUp (T-344). No test file covered these handlers before (only the
 * per-tick step dispatch is covered elsewhere, crafting/time_recipe.test.ts).
 * This system's command loop does not break after one command, so multiple
 * commands for ONE player in ONE tick is a real, reachable path — e.g. two
 * PickUp commands while walking through a loot pile.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, Registry, newEntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import { Position } from "../components/game.ts";
import { Inventory, ItemData } from "../components/items.ts";
import { WorkstationTag, WorkstationBuffer } from "../components/building.ts";
import { SpatialGrid } from "../spatial_grid.ts";
import { CraftingSystem } from "./crafting.ts";
import type { RecipeStepHandler } from "../crafting/step_handler.ts";
import type { TickContext } from "../system.ts";

const content = await JsonSource.load();

function station(world: World, x: number, y: number, slots: WorkstationBuffer_["slots"] = []): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x, y, z: 0 });
  world.write(id, WorkstationTag, { stationType: "workbench", qualityTier: 1 });
  world.write(id, WorkstationBuffer, { capacity: 4, activeRecipeId: null, slots });
  return id;
}
type WorkstationBuffer_ = { slots: ({ kind: "stack"; itemType: string; quantity: number } | { kind: "unique"; entityId: string; prefabId: string } | null)[] };

function player(world: World, x: number, y: number, invSlots: InvSlots = [], capacity = 20): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x, y, z: 0 });
  world.write(id, Inventory, { slots: invSlots, capacity });
  return id;
}
type InvSlots = ({ kind: "stack"; prefabId: string; quantity: number } | { kind: "unique"; entityId: string })[];

function groundItem(world: World, x: number, y: number, prefabId: string, quantity: number): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x, y, z: 0 });
  world.write(id, ItemData, { prefabId, quantity });
  return id;
}

/** Batches multiple (actor, command) pairs into one system.run() + one
 * applyChangeset — the same-tick shape T-344 targets. */
function runBatch(world: World, commands: Array<[actor: string, cmd: CommandPayload]>): void {
  const sys = new CraftingSystem(content, new Registry<RecipeStepHandler>());
  const grid = new SpatialGrid();
  grid.rebuild(world);
  const pending = new Map<string, CommandPayload[]>();
  for (const [actor, cmd] of commands) {
    const list = pending.get(actor) ?? [];
    list.push(cmd);
    pending.set(actor, list);
  }
  const ctx: TickContext = { spatial: grid, pendingCommands: pending };
  sys.prepare(0, ctx);
  sys.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
}

// ---- LoadWorkstation ----

Deno.test("LoadWorkstation: a stack item moves from inventory into a free buffer slot", () => {
  const w = new World();
  const st = station(w, 0, 0);
  const p = player(w, 0.5, 0, [{ kind: "stack", prefabId: "iron_ore", quantity: 3 }]);

  runBatch(w, [[p, { cmd: CommandType.LoadWorkstation, inventorySlot: 0, bufferSlot: 0 }]]);

  assertEquals(w.get(p, Inventory)!.slots.length, 0, "item left the inventory");
  const buf = w.get(st, WorkstationBuffer)!.slots;
  assertEquals(buf[0], { kind: "stack", itemType: "iron_ore", quantity: 3 });
});

Deno.test("T-344: two LoadWorkstation commands targeting the same station in one tick both land", () => {
  const w = new World();
  const st = station(w, 0, 0);
  const p1 = player(w, 0.5, 0, [{ kind: "stack", prefabId: "iron_ore", quantity: 2 }]);
  const p2 = player(w, 0.5, 0.1, [{ kind: "stack", prefabId: "coal", quantity: 1 }]);

  runBatch(w, [
    [p1, { cmd: CommandType.LoadWorkstation, inventorySlot: 0, bufferSlot: 0 }],
    [p2, { cmd: CommandType.LoadWorkstation, inventorySlot: 0, bufferSlot: 1 }],
  ]);

  assertEquals(w.get(p1, Inventory)!.slots.length, 0);
  assertEquals(w.get(p2, Inventory)!.slots.length, 0);
  const buf = w.get(st, WorkstationBuffer)!.slots;
  assert(buf.some((s) => s?.kind === "stack" && s.itemType === "iron_ore" && s.quantity === 2), "player 1's ore landed");
  assert(buf.some((s) => s?.kind === "stack" && s.itemType === "coal" && s.quantity === 1), "player 2's coal landed — not clobbered by player 1's load");
});

Deno.test("LoadWorkstation: declines cleanly when the buffer is full — item stays in inventory", () => {
  const w = new World();
  const st = station(w, 0, 0, [
    { kind: "stack", itemType: "birch_wood", quantity: 1 },
    { kind: "stack", itemType: "yew_wood", quantity: 1 },
    { kind: "stack", itemType: "oak_wood", quantity: 1 },
    { kind: "stack", itemType: "wood_handle", quantity: 1 },
  ]); // capacity 4, all full, none mergeable with iron_ore
  const p = player(w, 0.5, 0, [{ kind: "stack", prefabId: "iron_ore", quantity: 1 }]);

  runBatch(w, [[p, { cmd: CommandType.LoadWorkstation, inventorySlot: 0, bufferSlot: 4 }]]);

  assertEquals(w.get(p, Inventory)!.slots, [{ kind: "stack", prefabId: "iron_ore", quantity: 1 }], "declined — item never left the inventory");
});

// ---- TakeWorkstation ----

Deno.test("TakeWorkstation: a buffer slot moves into the player's inventory", () => {
  const w = new World();
  const st = station(w, 0, 0, [{ kind: "stack", itemType: "iron_ore", quantity: 2 }]);
  const p = player(w, 0.5, 0, []);

  runBatch(w, [[p, { cmd: CommandType.TakeWorkstation, bufferSlot: 0 }]]);

  assertEquals(w.get(st, WorkstationBuffer)!.slots[0], null);
  assertEquals(w.get(p, Inventory)!.slots, [{ kind: "stack", prefabId: "iron_ore", quantity: 2 }]);
});

Deno.test("T-344: TakeWorkstation racing a concurrent same-tick Inventory writer — both survive", () => {
  const w = new World();
  const st = station(w, 0, 0, [{ kind: "stack", itemType: "iron_ore", quantity: 2 }]);
  const p = player(w, 0.5, 0, [{ kind: "stack", prefabId: "berries", quantity: 1 }]);

  const sys = new CraftingSystem(content, new Registry<RecipeStepHandler>());
  const grid = new SpatialGrid();
  grid.rebuild(w);
  const ctx: TickContext = {
    spatial: grid,
    pendingCommands: new Map([[p, [{ cmd: CommandType.TakeWorkstation, bufferSlot: 0 } as CommandPayload]]]),
  };
  sys.prepare(0, ctx);
  sys.run(w, new EventBus(), 1 / 20);
  // Simulate a concurrent same-tick writer (e.g. DebugGiveItem).
  w.mutate(p, Inventory, (cur) => ({ ...cur, slots: [...cur.slots, { kind: "stack" as const, prefabId: "coal", quantity: 5 }] }));
  w.applyChangeset();

  const slots = w.get(p, Inventory)!.slots;
  assert(slots.some((s) => s.kind === "stack" && s.prefabId === "berries"), "original slot untouched");
  assert(slots.some((s) => s.kind === "stack" && s.prefabId === "iron_ore"), "take landed");
  assert(slots.some((s) => s.kind === "stack" && s.prefabId === "coal"), "the concurrent writer's append also landed");
});

Deno.test("TakeWorkstation: declines cleanly when the player's inventory is full — item stays in the buffer", () => {
  const w = new World();
  const st = station(w, 0, 0, [{ kind: "stack", itemType: "iron_ore", quantity: 2 }]);
  const p = player(w, 0.5, 0, [{ kind: "stack", prefabId: "berries", quantity: 1 }], 1);

  runBatch(w, [[p, { cmd: CommandType.TakeWorkstation, bufferSlot: 0 }]]);

  assertEquals(w.get(st, WorkstationBuffer)!.slots[0], { kind: "stack", itemType: "iron_ore", quantity: 2 }, "still banked — not lost");
  assertEquals(w.get(p, Inventory)!.slots, [{ kind: "stack", prefabId: "berries", quantity: 1 }]);
});

// ---- PickUp ----

Deno.test("PickUp: a stackable ground item merges into an existing matching stack", () => {
  const w = new World();
  const p = player(w, 0, 0, [{ kind: "stack", prefabId: "berries", quantity: 2 }]);
  const drop = groundItem(w, 0.2, 0, "berries", 3);

  runBatch(w, [[p, { cmd: CommandType.PickUp, entityId: drop }]]);

  assertEquals(w.get(p, Inventory)!.slots, [{ kind: "stack", prefabId: "berries", quantity: 5 }]);
  assertEquals(w.isAlive(drop), false, "ground entity consumed");
});

Deno.test("T-344: two PickUp commands for the same player in one tick with room for only one — inventory never exceeds capacity", () => {
  const w = new World();
  const p = player(w, 0, 0, [], 1); // room for exactly one item, nothing held yet
  const dropA = groundItem(w, 0.1, 0, "iron_sword", 1); // unique, non-stackable
  const dropB = groundItem(w, 0.2, 0, "iron_sword", 1); // unique, non-stackable

  runBatch(w, [
    [p, { cmd: CommandType.PickUp, entityId: dropA }],
    [p, { cmd: CommandType.PickUp, entityId: dropB }],
  ]);

  const slots = w.get(p, Inventory)!.slots;
  assertEquals(slots.length, 1, "capacity never exceeded");
  // T-344 documented residual: the LOSING pickup's world.remove(Position)
  // already ran (irreversible, ahead of the capacity recheck) even though
  // its Inventory append declined — the entity survives but is neither
  // in the world nor in any inventory. Locked in as an explicit assertion
  // so this is a visible, deliberate acceptance, not a silent gap.
  const winner = slots[0].kind === "unique" ? slots[0].entityId : null;
  const loser = winner === dropA ? dropB : dropA;
  assert(w.isAlive(loser), "the losing pickup's entity is not destroyed (unique path uses world.remove(Position), not world.destroy)");
  assertEquals(w.has(loser as string, Position), false, "…but it did lose its Position — the documented residual");
});

Deno.test("PickUp: declines cleanly when the inventory is already full (non-stackable) — ground item survives untouched", () => {
  const w = new World();
  const p = player(w, 0, 0, [{ kind: "stack", prefabId: "berries", quantity: 1 }], 1);
  const drop = groundItem(w, 0.1, 0, "iron_sword", 1);

  runBatch(w, [[p, { cmd: CommandType.PickUp, entityId: drop }]]);

  assertEquals(w.get(p, Inventory)!.slots, [{ kind: "stack", prefabId: "berries", quantity: 1 }]);
  assert(w.isAlive(drop));
  assert(w.has(drop, Position), "declined before the irreversible Position-strip — item stays a normal world pickup");
});
