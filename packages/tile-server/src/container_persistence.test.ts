/**
 * Dynasty-chest persistence (T-077/T-078) — the heritage outliving the heir.
 *
 *   - SAVE ROUND-TRIP (the core): a deployed library/treasury chest AND the
 *     unique item entities its slots reference (tomes/gear, with their instance
 *     components) survive serialize → deserialize into a fresh World, with the
 *     slot refs re-resolving and the owning dynasty preserved.
 *   - DEATH SURVIVAL: depositing into the chest, then killing the owning player,
 *     leaves the chest + items alive (death destroys only the player + worn gear)
 *     — "persists across character deaths".
 *   - HEIR EQUIP: a fresh heir (same dynastyId, new entityId) withdraws banked
 *     gear and equips it — the server side of "heir equips from the treasury".
 */
import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { Registry, World, EventBus, newEntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import type { TileSaveRepo } from "@voxim/db";
import { SaveManager } from "./save_manager.ts";
import { spawnPrefab, destroyCarriedItemEntities } from "./spawner.ts";
import { Container } from "./components/container.ts";
import { Inventory, ItemData } from "./components/items.ts";
import { Equipment } from "./components/equipment.ts";
import { Heritage } from "./components/heritage.ts";
import { Inscribed, Durability, QualityStamped } from "./components/instance.ts";
import { Position } from "./components/game.ts";
import { DeathSystem } from "./systems/death.ts";
import type { DeathHook } from "./systems/death.ts";
import { EquipmentSystem } from "./systems/equipment.ts";
import { storeInContainer, withdrawFromContainer } from "./systems/container.ts";
import type { TickContext } from "./system.ts";

const content = await JsonSource.load("packages/content/data");
const DYN = "dynasty-keeper";
const stubRepo: TileSaveRepo = { get: () => Promise.resolve(null), put: () => Promise.resolve(), delete: () => Promise.resolve() };
const manager = () => new SaveManager(stubRepo, content, "world-test", "0_0");

const EMPTY_EQUIP = { weapon: null, offHand: null, head: null, chest: null, legs: null, feet: null, back: null };

function deployChest(world: World, prefabId: string, dynastyId: string, x = 0, y = 0): string {
  const id = spawnPrefab(world, content, prefabId, { x, y, z: 0 });
  const c = world.get(id, Container)!;
  world.write(id, Container, { ...c, dynastyId });
  return id;
}
function bankItem(world: World, chestId: string, ownerId: string, prefabId: string, instance: (id: string) => void): string {
  const item = newEntityId();
  world.create(item);
  world.write(item, ItemData, { prefabId, quantity: 1 });
  instance(item);
  // route through the real store op (owner holds it, then deposits)
  world.write(ownerId, Inventory, { slots: [{ kind: "unique", entityId: item }], capacity: 20 });
  const r = storeInContainer(world, content, ownerId, chestId, item);
  assert(r.ok, `bankItem store failed: ${JSON.stringify(r)}`);
  return item;
}
function makeOwner(world: World, dynastyId: string): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Heritage, { dynastyId, generation: 0, traits: [] });
  world.write(id, Inventory, { slots: [], capacity: 20 });
  return id;
}

Deno.test("1: chest + banked tome/gear (with instance comps) survive a save round-trip", () => {
  const src = new World();
  const owner = makeOwner(src, DYN);
  const lib = deployChest(src, "library_chest", DYN, 100.5, 50);
  const tome = bankItem(src, lib, owner, "tome", (id) => src.write(id, Inscribed, { fragmentId: "keen_edge" }));
  const treas = deployChest(src, "treasury_chest", DYN, 60, 70);
  const sword = bankItem(src, treas, owner, "iron_sword", (id) => {
    src.write(id, Durability, { remaining: 42, max: 60 });
    src.write(id, QualityStamped, { quality: 0.8 });
  });

  const bytes = manager().serialize(src);
  const dst = new World();
  assert(manager().deserialize(dst, bytes), "load succeeded");

  // Chests reload (same UUIDs) with owner + kind preserved, slots re-linked.
  const lib2 = dst.get(lib, Container)!;
  assertEquals(lib2.kind, "tome");
  assertEquals(lib2.dynastyId, DYN);
  assertEquals(lib2.slots.map((s) => s.entityId), [tome]);
  assertAlmostEquals(dst.get(lib, Position)!.x, 100.5, 0.01);

  const treas2 = dst.get(treas, Container)!;
  assertEquals(treas2.dynastyId, DYN);
  assertEquals(treas2.slots.map((s) => s.entityId), [sword]);

  // The referenced item entities are live + their instance components survived.
  assert(dst.isAlive(tome) && dst.isAlive(sword), "banked item entities reloaded");
  assertEquals(dst.get(tome, ItemData)!.prefabId, "tome");
  assertEquals(dst.get(tome, Inscribed)!.fragmentId, "keen_edge");
  assertEquals(dst.get(sword, Durability)!.remaining, 42);
  assertAlmostEquals(dst.get(sword, QualityStamped)!.quality, 0.8, 0.001);
  // A banked item is held, not placed — it must carry no Position.
  assert(!dst.has(tome, Position) && !dst.has(sword, Position), "banked items have no Position");
});

Deno.test("1c: an empty deployed chest round-trips with no stray item entities", () => {
  const src = new World();
  const lib = deployChest(src, "library_chest", DYN, 5, 5);
  const bytes = manager().serialize(src);
  const dst = new World();
  assert(manager().deserialize(dst, bytes));
  assertEquals(dst.get(lib, Container)!.slots.length, 0);
  assertEquals([...dst.query(ItemData)].length, 0, "no phantom item entities created");
});

Deno.test("1d: stored item count is preserved (no drop, no dup)", () => {
  const src = new World();
  const owner = makeOwner(src, DYN);
  const treas = deployChest(src, "treasury_chest", DYN);
  bankItem(src, treas, owner, "iron_sword", (id) => src.write(id, Durability, { remaining: 10, max: 60 }));
  const before = [...src.query(ItemData)].length;
  const dst = new World();
  assert(manager().deserialize(dst, manager().serialize(src)));
  assertEquals([...dst.query(ItemData)].length, before);
});

Deno.test("1e: a dangling slot ref doesn't crash serialize/deserialize", () => {
  const src = new World();
  const lib = deployChest(src, "library_chest", DYN);
  // Point a slot at an id that was never alive.
  const c = src.get(lib, Container)!;
  src.write(lib, Container, { ...c, slots: [{ entityId: newEntityId() }] });
  const dst = new World();
  assert(manager().deserialize(dst, manager().serialize(src)), "non-fatal");
  // The ref string persists in the Container, but resolves to no live entity.
  const ref = dst.get(lib, Container)!.slots[0].entityId;
  assert(!dst.isAlive(ref), "dangling ref stays dangling, not invented");
});

Deno.test("2: chest + banked items survive the owning player's death", () => {
  const world = new World();
  const player = makeOwner(world, DYN);
  // The player also wears a weapon entity (to show equip_cleanup destroys THAT).
  const worn = newEntityId();
  world.create(worn);
  world.write(worn, ItemData, { prefabId: "iron_sword", quantity: 1 });
  world.write(player, Equipment, { ...EMPTY_EQUIP, weapon: { entityId: worn, prefabId: "iron_sword" } });

  const treas = deployChest(world, "treasury_chest", DYN);
  const banked = bankItem(world, treas, player, "iron_sword", (id) => world.write(id, Durability, { remaining: 7, max: 60 }));

  const hooks = new Registry<DeathHook>();
  hooks.register({ id: "equip_cleanup", onDeath: (ctx) => destroyCarriedItemEntities(ctx.world, ctx.entityId) });
  const deaths = new DeathSystem(hooks);
  deaths.request({ entityId: player, cause: "damage" });
  deaths.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();

  assert(!world.isAlive(player), "player gone");
  assert(!world.isAlive(worn), "worn weapon cleaned up with the player");
  assert(world.isAlive(treas), "treasury chest persists");
  assert(world.isAlive(banked), "banked gear persists");
  assertEquals(world.get(banked, Durability)!.remaining, 7, "untouched");
});

Deno.test("4: a fresh heir (same dynasty) withdraws banked gear and equips it", () => {
  const world = new World();
  const ancestor = makeOwner(world, DYN);
  const treas = deployChest(world, "treasury_chest", DYN);
  const sword = bankItem(world, treas, ancestor, "iron_sword", (id) => world.write(id, Durability, { remaining: 42, max: 60 }));
  world.destroy(ancestor);
  world.applyChangeset();

  // New heir entity, same dynastyId.
  const heir = newEntityId();
  world.create(heir);
  world.write(heir, Heritage, { dynastyId: DYN, generation: 1, traits: [] });
  world.write(heir, Inventory, { slots: [], capacity: 20 });
  world.write(heir, Equipment, { ...EMPTY_EQUIP });

  const wr = withdrawFromContainer(world, heir, treas, 0, heir);
  assert(wr.ok, `heir withdraw: ${JSON.stringify(wr)}`);
  assert(world.get(heir, Inventory)!.slots.some((s) => s.kind === "unique" && s.entityId === sword));

  // Equip from inventory slot 0.
  const sys = new EquipmentSystem(content);
  const cmd: CommandPayload = { cmd: CommandType.Equip, fromInventorySlot: 0 };
  const ctx: TickContext = { spatial: null as unknown as TickContext["spatial"], pendingCommands: new Map([[heir, [cmd]]]) };
  sys.prepare(0, ctx);
  sys.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();

  assertEquals(world.get(heir, Equipment)!.weapon?.entityId, sword, "heir wields the ancestor's sword");
  assertEquals(world.get(sword, Durability)!.remaining, 42, "the gear's wear carried across generations");
});

Deno.test("4b: a wrong-dynasty actor cannot withdraw from the treasury", () => {
  const world = new World();
  const owner = makeOwner(world, DYN);
  const treas = deployChest(world, "treasury_chest", DYN);
  bankItem(world, treas, owner, "iron_sword", (id) => world.write(id, Durability, { remaining: 1, max: 60 }));
  const stranger = makeOwner(world, "other-dynasty");
  assert(!withdrawFromContainer(world, stranger, treas, 0, stranger).ok, "blocked");
  assertEquals(world.get(treas, Container)!.slots.length, 1, "nothing left the chest");
});
