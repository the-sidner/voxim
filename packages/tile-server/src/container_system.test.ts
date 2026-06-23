/**
 * ContainerSystem (T-284) — the command path that drives deposit/withdraw from
 * the chest panel. Pins: a deposit/withdraw MOVES the unique item via the
 * changeset (so the chest+inventory changes ship to the client as deltas — an
 * immediate world.write would mutate the store but never produce a delta), the
 * proximity gate refuses a far-away actor, and only unique-entity slots bank.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import { spawnPrefab } from "./spawner.ts";
import { Container } from "./components/container.ts";
import { Inventory, ItemData } from "./components/items.ts";
import type { InventorySlot } from "@voxim/codecs";
import { Heritage } from "./components/heritage.ts";
import { Position } from "./components/game.ts";
import { ContainerSystem } from "./systems/container.ts";
import type { TickContext } from "./system.ts";

const content = await JsonSource.load("packages/content/data");
const DYN = "dynasty-A";

function deployChest(world: World, dynastyId: string, x = 0, y = 0): string {
  const id = spawnPrefab(world, content, "treasury_chest", { x, y, z: 0 });
  const c = world.get(id, Container)!;
  world.write(id, Container, { ...c, dynastyId });
  return id;
}

function makePlayer(world: World, dynastyId: string, x: number, y: number, slots: InventorySlot[]): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Heritage, { dynastyId, generation: 0, traits: [] });
  world.write(id, Position, { x, y, z: 0 });
  world.write(id, Inventory, { slots, capacity: 20 });
  return id;
}

function uniqueSword(world: World): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, ItemData, { prefabId: "iron_sword", quantity: 1 });
  return id;
}

function tick(world: World, sys: ContainerSystem, actorId: string, cmd: CommandPayload): void {
  const ctx: TickContext = {
    spatial: null as unknown as TickContext["spatial"],
    pendingCommands: new Map([[actorId, [cmd]]]),
  };
  sys.prepare(0, ctx);
  sys.run(world, new EventBus(), 1 / 20);
}

Deno.test("deposit moves a unique item into the chest — via the changeset, not immediately", () => {
  const w = new World();
  const chest = deployChest(w, DYN, 0, 0);
  const sword = uniqueSword(w);
  const player = makePlayer(w, DYN, 1, 0, [{ kind: "unique", entityId: sword }]);
  const sys = new ContainerSystem(content);

  tick(w, sys, player, { cmd: CommandType.ContainerDeposit, containerId: chest, fromInventorySlot: 0 });

  // Deferred: nothing has moved until the tick commits its changeset — this is
  // what makes the move a networked delta rather than an invisible write.
  assertEquals(w.get(chest, Container)!.slots.length, 0, "still pending pre-commit");
  assertEquals(w.get(player, Inventory)!.slots.length, 1, "still pending pre-commit");

  w.applyChangeset();
  assertEquals(w.get(chest, Container)!.slots.map((s) => s.entityId), [sword]);
  assertEquals(w.get(player, Inventory)!.slots.length, 0, "item left the inventory");
  assert(w.isAlive(sword), "the item entity itself is untouched");
});

Deno.test("withdraw moves the banked item back into the player's inventory", () => {
  const w = new World();
  const chest = deployChest(w, DYN, 0, 0);
  const sword = uniqueSword(w);
  const player = makePlayer(w, DYN, 1, 0, [{ kind: "unique", entityId: sword }]);
  const sys = new ContainerSystem(content);

  tick(w, sys, player, { cmd: CommandType.ContainerDeposit, containerId: chest, fromInventorySlot: 0 });
  w.applyChangeset();
  tick(w, sys, player, { cmd: CommandType.ContainerWithdraw, containerId: chest, slotIndex: 0 });
  w.applyChangeset();

  assertEquals(w.get(chest, Container)!.slots.length, 0);
  assert(w.get(player, Inventory)!.slots.some((s) => s.kind === "unique" && s.entityId === sword));
});

Deno.test("the proximity gate refuses a deposit from a far-away actor", () => {
  const w = new World();
  const chest = deployChest(w, DYN, 0, 0);
  const sword = uniqueSword(w);
  const player = makePlayer(w, DYN, 50, 50, [{ kind: "unique", entityId: sword }]); // way out of reach
  const sys = new ContainerSystem(content);

  tick(w, sys, player, { cmd: CommandType.ContainerDeposit, containerId: chest, fromInventorySlot: 0 });
  w.applyChangeset();

  assertEquals(w.get(chest, Container)!.slots.length, 0, "nothing banked from out of range");
  assertEquals(w.get(player, Inventory)!.slots.length, 1, "item stayed in the inventory");
});

Deno.test("a stack slot does not bank — only unique-entity items go into a chest", () => {
  const w = new World();
  const chest = deployChest(w, DYN, 0, 0);
  const player = makePlayer(w, DYN, 1, 0, [{ kind: "stack", prefabId: "iron_ingot", quantity: 5 }]);
  const sys = new ContainerSystem(content);

  tick(w, sys, player, { cmd: CommandType.ContainerDeposit, containerId: chest, fromInventorySlot: 0 });
  w.applyChangeset();

  assertEquals(w.get(chest, Container)!.slots.length, 0, "a stack can't bank (no entity ref)");
  assertEquals(w.get(player, Inventory)!.slots.length, 1, "the stack stayed put");
});
