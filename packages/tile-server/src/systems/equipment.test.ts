/**
 * Dual-slot equip routing (T-187): an item declares an ordered list of
 * candidate equip slots; the equip flow lands it in the first one that's free.
 * So a weapon (`slots: ["weapon","offHand"]`) fills the off-hand when the main
 * hand is taken — dual-wield from the inventory — and is rejected only when
 * every candidate is occupied. Runs against real content.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { CommandType, EquipSlotIndex } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import { Equipment } from "../components/equipment.ts";
import { Inventory } from "../components/items.ts";
import { EquipmentSystem } from "./equipment.ts";
import type { TickContext } from "../system.ts";
import { spawnPrefab, findBoneEntity } from "../spawner.ts";

const content = await JsonSource.load();

const EMPTY_EQUIP = {
  weapon: null, offHand: null, head: null, chest: null, legs: null, feet: null, back: null,
};

function runCmd(world: World, actor: string, cmd: CommandPayload): void {
  const sys = new EquipmentSystem(content);
  const ctx: TickContext = {
    spatial: null as unknown as TickContext["spatial"],
    pendingCommands: new Map([[actor, [cmd]]]),
  };
  sys.prepare(0, ctx);
  sys.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
}

function run(world: World, actor: string, fromInventorySlot: number): void {
  runCmd(world, actor, { cmd: CommandType.Equip, fromInventorySlot });
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

// ---- T-219/T-220: equip/unequip compose the scene graph ------------------

Deno.test("equip: on a real skeletal actor (spawned via spawnPrefab), the item entity parents to the resolved bone", () => {
  const w = new World();
  const actor = spawnPrefab(w, content, "player", { x: 0, y: 0, z: 0 });
  // Real skeleton, real bones. Overwrite Inventory with a controlled single
  // chest-armour stack so the equip flow lands somewhere deterministic
  // (the player's default startingEquipment already occupies weapon/offHand).
  w.write(actor, Inventory, { slots: [{ kind: "stack", prefabId: "cloth_tunic", quantity: 1 }], capacity: 20 });

  run(w, actor, 0);

  const eq = w.get(actor, Equipment)!;
  assertEquals(eq.chest?.prefabId, "cloth_tunic");
  const torsoUpperBone = findBoneEntity(w, actor, "torso_upper");
  assert(torsoUpperBone, "player skeleton has a torso_upper bone");
  assertEquals(w.getParent(eq.chest!.entityId as string), torsoUpperBone);
});

Deno.test("unequip: clears the scene-graph parent (world.getParent(itemId) === null)", () => {
  const w = new World();
  const actor = spawnPrefab(w, content, "player", { x: 0, y: 0, z: 0 });
  w.write(actor, Inventory, { slots: [{ kind: "stack", prefabId: "cloth_tunic", quantity: 1 }], capacity: 20 });
  run(w, actor, 0);

  const equippedItemId = w.get(actor, Equipment)!.chest!.entityId as string;
  assert(w.getParent(equippedItemId) !== null, "sanity: scene-graph attached after equip");

  runCmd(w, actor, { cmd: CommandType.Unequip, equipSlot: EquipSlotIndex.Chest });

  assertEquals(w.get(actor, Equipment)!.chest, null);
  assertEquals(w.getParent(equippedItemId), null, "unequip reparents to null");
});

Deno.test("equip: an actor with no skeleton at all falls back gracefully — the item parents to the actor root, not null, not a crash", () => {
  const w = new World();
  const actor = newEntityId();
  w.create(actor); // bare fixture — no ModelRef, no bones, matches the file's other tests
  w.write(actor, Equipment, { ...EMPTY_EQUIP });
  w.write(actor, Inventory, { slots: [{ kind: "stack", prefabId: "cloth_tunic", quantity: 1 }], capacity: 20 });

  run(w, actor, 0);

  const eq = w.get(actor, Equipment)!;
  assertEquals(eq.chest?.prefabId, "cloth_tunic");
  assertEquals(w.getParent(eq.chest!.entityId as string), actor, "no bone to attach to — falls back to the holder root");
});
