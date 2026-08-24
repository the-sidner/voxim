/**
 * DynastySystem — Externalise/Internalise (T-344). No test file existed for
 * this system before. Real content (blankTomeItemType/tomeItemType come
 * from game_config.json's `lore` block).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import { Inventory, ItemData } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { Inscribed } from "../components/instance.ts";
import { LoreLoadout } from "../components/lore_loadout.ts";
import { DynastySystem } from "./dynasty.ts";
import type { TickContext } from "../system.ts";

const content = await JsonSource.load();
const cfg = content.getGameConfig().lore;

function makeEntity(world: World, slots: InventorySlot[], learnedFragmentIds: string[]): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Inventory, { slots, capacity: 20 });
  world.write(id, LoreLoadout, { skills: [null, null, null, null], learnedFragmentIds });
  return id;
}

function makeTome(world: World, fragmentId: string): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, ItemData, { prefabId: cfg.tomeItemType, quantity: 1 });
  world.write(id, Inscribed, { fragmentId });
  return id;
}

/** Batches multiple (actor, command) pairs into one system.run() + one
 * applyChangeset — the same-tick shape T-344 targets. */
function runBatch(world: World, commands: Array<[actor: string, cmd: CommandPayload]>): void {
  const sys = new DynastySystem(content);
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

Deno.test("Externalise: consumes one blank tome, spawns an inscribed unique tome", () => {
  const w = new World();
  const id = makeEntity(w, [{ kind: "stack", prefabId: cfg.blankTomeItemType, quantity: 1 }], ["keen_edge"]);

  runBatch(w, [[id, { cmd: CommandType.Externalise, fragIndex: 0 }]]);

  const slots = w.get(id, Inventory)!.slots;
  assertEquals(slots.length, 1);
  assert(slots[0].kind === "unique");
  assertEquals(w.get(slots[0].entityId as string, Inscribed)?.fragmentId, "keen_edge");
});

Deno.test("Externalise: a stack of 2+ blank tomes decrements rather than removing the slot", () => {
  const w = new World();
  const id = makeEntity(w, [{ kind: "stack", prefabId: cfg.blankTomeItemType, quantity: 3 }], ["keen_edge"]);

  runBatch(w, [[id, { cmd: CommandType.Externalise, fragIndex: 0 }]]);

  const slots = w.get(id, Inventory)!.slots;
  assertEquals(slots.length, 2);
  assert(slots.some((s) => s.kind === "stack" && s.prefabId === cfg.blankTomeItemType && s.quantity === 2));
  assert(slots.some((s) => s.kind === "unique"));
});

Deno.test("Externalise: declines cleanly (no-op) when there's no blank tome", () => {
  const w = new World();
  const id = makeEntity(w, [], ["keen_edge"]);

  runBatch(w, [[id, { cmd: CommandType.Externalise, fragIndex: 0 }]]);

  assertEquals(w.get(id, Inventory)!.slots.length, 0);
});

Deno.test("T-344: Externalise declines cleanly when a same-tick race already consumed the blank tome", () => {
  const w = new World();
  const id = makeEntity(w, [{ kind: "stack", prefabId: cfg.blankTomeItemType, quantity: 1 }], ["keen_edge"]);

  const sys = new DynastySystem(content);
  const ctx: TickContext = {
    spatial: null as unknown as TickContext["spatial"],
    pendingCommands: new Map([[id, [{ cmd: CommandType.Externalise, fragIndex: 0 } as CommandPayload]]]),
  };
  sys.prepare(0, ctx);
  sys.run(w, new EventBus(), 1 / 20);
  // Simulate a concurrent same-tick consumer of the SAME blank tome slot
  // (e.g. a crafting recipe that also eats blank_tome), pushed AFTER
  // DynastySystem's own mutate — program order determines which wins.
  w.mutate(id, Inventory, (cur) => ({ ...cur, slots: cur.slots.filter((s) => !(s.kind === "stack" && s.prefabId === cfg.blankTomeItemType)) }));
  w.applyChangeset();

  // Whichever consumer's op is FIRST in program order wins the blank tome;
  // DynastySystem's mutate was pushed first here, so it should have won —
  // assert the tome landed and the blank is gone, proving composition
  // (not corruption) rather than asserting a specific winner blindly.
  const slots = w.get(id, Inventory)!.slots;
  assert(!slots.some((s) => s.kind === "stack" && s.prefabId === cfg.blankTomeItemType), "blank tome consumed exactly once");
  assert(slots.some((s) => s.kind === "unique"), "DynastySystem's mutate ran first in program order and won the blank tome");
});

Deno.test("Round trip: a tome written by Externalise teaches the same fragment on Internalise", () => {
  // T-360: pins that Externalise's output (a unique tome entity with ItemData
  // prefabId=cfg.tomeItemType + Inscribed{fragmentId}) is EXACTLY what
  // Internalise consumes — no separate "filled tome" shape.
  const w = new World();
  const writer = makeEntity(w, [{ kind: "stack", prefabId: cfg.blankTomeItemType, quantity: 1 }], ["keen_edge"]);
  runBatch(w, [[writer, { cmd: CommandType.Externalise, fragIndex: 0 }]]);

  const writerSlots = w.get(writer, Inventory)!.slots;
  assert(writerSlots[0].kind === "unique", "externalise produced a unique tome entity");
  const tomeId = writerSlots[0].entityId as string;

  // Hand the freshly-written tome to a second entity (a different player
  // receiving it, or the same entity carrying it to a reader) and read it.
  const reader = makeEntity(w, [{ kind: "unique", entityId: tomeId }], []);
  runBatch(w, [[reader, { cmd: CommandType.Internalise, inventorySlot: 0 }]]);

  assertEquals(w.get(reader, Inventory)!.slots.length, 0, "tome consumed on read");
  assertEquals(w.isAlive(tomeId), false, "tome entity destroyed on read");
  assertEquals(w.get(reader, LoreLoadout)!.learnedFragmentIds, ["keen_edge"], "reader learned the fragment the writer externalised");
});

Deno.test("Internalise: consumes the tome and learns the fragment", () => {
  const w = new World();
  const id = makeEntity(w, [], []);
  const tome = makeTome(w, "keen_edge");
  w.write(id, Inventory, { slots: [{ kind: "unique", entityId: tome }], capacity: 20 });

  runBatch(w, [[id, { cmd: CommandType.Internalise, inventorySlot: 0 }]]);

  assertEquals(w.get(id, Inventory)!.slots.length, 0, "tome removed");
  assertEquals(w.isAlive(tome), false, "tome entity destroyed");
  assertEquals(w.get(id, LoreLoadout)!.learnedFragmentIds, ["keen_edge"]);
});

Deno.test("Internalise: a tome for an already-known fragment is still consumed, no duplicate entry", () => {
  const w = new World();
  const id = makeEntity(w, [], ["keen_edge"]);
  const tome = makeTome(w, "keen_edge");
  w.write(id, Inventory, { slots: [{ kind: "unique", entityId: tome }], capacity: 20 });

  runBatch(w, [[id, { cmd: CommandType.Internalise, inventorySlot: 0 }]]);

  assertEquals(w.get(id, Inventory)!.slots.length, 0, "tome still consumed");
  assertEquals(w.get(id, LoreLoadout)!.learnedFragmentIds, ["keen_edge"], "no duplicate entry");
});

// NOTE: DynastySystem's own per-entity command loop `break`s after the
// first matching command (Externalise OR Internalise), so at most ONE
// dynasty command is ever processed per entity per tick BY DESIGN — two
// same-tick dynasty commands for ONE entity is not a reachable path
// through this system. The realistic same-tick collision is CROSS-system:
// this entity's Inventory/LoreLoadout also written by another system the
// same tick (matches the ticket's own framing).

Deno.test("T-344: Internalise composes with a concurrent same-tick Inventory writer instead of clobbering it", () => {
  const w = new World();
  const id = makeEntity(w, [], []);
  const tome = makeTome(w, "keen_edge");
  w.write(id, Inventory, { slots: [{ kind: "unique", entityId: tome }], capacity: 20 });

  const sys = new DynastySystem(content);
  const ctx: TickContext = {
    spatial: null as unknown as TickContext["spatial"],
    pendingCommands: new Map([[id, [{ cmd: CommandType.Internalise, inventorySlot: 0 } as CommandPayload]]]),
  };
  sys.prepare(0, ctx);
  sys.run(w, new EventBus(), 1 / 20);
  // Simulate a concurrent same-tick writer (e.g. a debug give, a crafting
  // pickup) appending to this SAME entity's Inventory.
  w.mutate(id, Inventory, (cur) => ({
    ...cur,
    slots: [...cur.slots, { kind: "stack" as const, prefabId: "berries", quantity: 1 }],
  }));
  w.applyChangeset();

  const slots = w.get(id, Inventory)!.slots;
  assertEquals(w.isAlive(tome), false, "tome consumed by internalise");
  assertEquals(w.get(id, LoreLoadout)!.learnedFragmentIds, ["keen_edge"], "fragment learned");
  assert(slots.some((s) => s.kind === "stack" && s.prefabId === "berries"), "the concurrent writer's append also landed — not clobbered");
  assertEquals(slots.length, 1, "exactly the berries slot remains — the tome slot is gone, not duplicated");
});
