/**
 * Dual-slot equip routing (T-187): an item declares an ordered list of
 * candidate equip slots; the equip flow lands it in the first one that's free.
 * So a weapon (`slots: ["weapon","offHand"]`) fills the off-hand when the main
 * hand is taken — dual-wield from the inventory — and is rejected only when
 * every candidate is occupied. Runs against real content.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import { Equipment } from "../components/equipment.ts";
import { Inventory } from "../components/items.ts";
import { EquipmentSystem } from "./equipment.ts";
import type { TickContext } from "../system.ts";

const content = await JsonSource.load();

const EMPTY_EQUIP = {
  weapon: null, offHand: null, head: null, chest: null, legs: null, feet: null, back: null,
};

function run(world: World, actor: string, fromInventorySlot: number): void {
  const sys = new EquipmentSystem(content);
  const cmd: CommandPayload = { cmd: CommandType.Equip, fromInventorySlot };
  const ctx: TickContext = {
    spatial: null as unknown as TickContext["spatial"],
    pendingCommands: new Map([[actor, [cmd]]]),
  };
  sys.prepare(0, ctx);
  sys.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
}

Deno.test("equip: a weapon fills the off-hand when the main hand is occupied", () => {
  const w = new World();
  const actor = newEntityId();
  w.create(actor);
  w.write(actor, Equipment, { ...EMPTY_EQUIP, weapon: { entityId: newEntityId(), prefabId: "stone_axe" } });
  w.write(actor, Inventory, { slots: [{ kind: "stack", prefabId: "stone_pickaxe", quantity: 1 }], capacity: 20 });

  run(w, actor, 0);

  const eq = w.get(actor, Equipment)!;
  assertEquals(eq.weapon?.prefabId, "stone_axe", "main hand untouched");
  assertEquals(eq.offHand?.prefabId, "stone_pickaxe", "second weapon routed to off-hand");
  assertEquals(w.get(actor, Inventory)!.slots.length, 0, "item left the inventory");
});

Deno.test("equip: a weapon takes the main hand when both hands are free", () => {
  const w = new World();
  const actor = newEntityId();
  w.create(actor);
  w.write(actor, Equipment, { ...EMPTY_EQUIP });
  w.write(actor, Inventory, { slots: [{ kind: "stack", prefabId: "stone_pickaxe", quantity: 1 }], capacity: 20 });

  run(w, actor, 0);

  const eq = w.get(actor, Equipment)!;
  assertEquals(eq.weapon?.prefabId, "stone_pickaxe", "first free candidate is the main hand");
  assertEquals(eq.offHand, null);
});

Deno.test("equip: rejected when every candidate slot is occupied", () => {
  const w = new World();
  const actor = newEntityId();
  w.create(actor);
  w.write(actor, Equipment, {
    ...EMPTY_EQUIP,
    weapon: { entityId: newEntityId(), prefabId: "stone_axe" },
    offHand: { entityId: newEntityId(), prefabId: "iron_sword" },
  });
  w.write(actor, Inventory, { slots: [{ kind: "stack", prefabId: "stone_pickaxe", quantity: 1 }], capacity: 20 });

  run(w, actor, 0);

  const eq = w.get(actor, Equipment)!;
  assertEquals(eq.weapon?.prefabId, "stone_axe");
  assertEquals(eq.offHand?.prefabId, "iron_sword");
  assertEquals(w.get(actor, Inventory)!.slots.length, 1, "rejected item stays in the inventory");
});

Deno.test("equip: a single-slot item (armour) routes to its one slot", () => {
  const w = new World();
  const actor = newEntityId();
  w.create(actor);
  w.write(actor, Equipment, { ...EMPTY_EQUIP });
  w.write(actor, Inventory, { slots: [{ kind: "stack", prefabId: "cloth_tunic", quantity: 1 }], capacity: 20 });

  run(w, actor, 0);

  const eq = w.get(actor, Equipment)!;
  assertEquals(eq.chest?.prefabId, "cloth_tunic");
  assert(eq.weapon === null && eq.offHand === null, "armour never lands in a hand");
});
