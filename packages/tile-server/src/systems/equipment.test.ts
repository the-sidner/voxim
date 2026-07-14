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
import { Position } from "../components/game.ts";
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

/** Batches multiple commands for ONE actor into one system.run() + one
 * applyChangeset — EquipmentSystem's per-entity command loop does not
 * break after one command, so this is a real, reachable same-tick shape
 * (T-344), not just synthetic. */
function runBatch(world: World, actor: string, cmds: CommandPayload[]): void {
  const sys = new EquipmentSystem(content);
  const ctx: TickContext = {
    spatial: null as unknown as TickContext["spatial"],
    pendingCommands: new Map([[actor, cmds]]),
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

// ---- T-344: Inventory + Equipment are multi-writer (world.mutate, not get-then-set) ----
// This system's per-entity command loop does not break after one command, so
// multiple commands for ONE player in ONE tick is a real, reachable path
// (rapid inventory clicks), not just a cross-system scenario.

Deno.test("T-344: two Equip commands for non-overlapping candidate slots in one tick both land", () => {
  const w = new World();
  const actor = newEntityId();
  w.create(actor);
  w.write(actor, Equipment, { ...EMPTY_EQUIP });
  w.write(actor, Inventory, {
    slots: [
      { kind: "stack", prefabId: "stone_pickaxe", quantity: 1 }, // slots: ["weapon","offHand"]
      { kind: "stack", prefabId: "cloth_tunic", quantity: 1 },   // slots: ["chest"]
    ],
    capacity: 20,
  });

  runBatch(w, actor, [
    { cmd: CommandType.Equip, fromInventorySlot: 0 },
    { cmd: CommandType.Equip, fromInventorySlot: 1 },
  ]);

  const eq = w.get(actor, Equipment)!;
  assertEquals(eq.weapon?.prefabId, "stone_pickaxe", "no shared candidate — both equips compose");
  assertEquals(eq.chest?.prefabId, "cloth_tunic");
  assertEquals(w.get(actor, Inventory)!.slots.length, 0, "both items left the inventory");
});

Deno.test("T-344: two same-tick Equip commands contending for the SAME candidate slot — the second declines cleanly (no cross-candidate retry), item stays in inventory", () => {
  const w = new World();
  const actor = newEntityId();
  w.create(actor);
  w.write(actor, Equipment, { ...EMPTY_EQUIP });
  w.write(actor, Inventory, {
    slots: [
      { kind: "stack", prefabId: "stone_pickaxe", quantity: 1 }, // slots: ["weapon","offHand"]
      { kind: "stack", prefabId: "iron_sword", quantity: 1 },    // slots: ["weapon","offHand"]
    ],
    capacity: 20,
  });

  runBatch(w, actor, [
    { cmd: CommandType.Equip, fromInventorySlot: 0 },
    { cmd: CommandType.Equip, fromInventorySlot: 1 },
  ]);

  const eq = w.get(actor, Equipment)!;
  // Both commands independently resolve "weapon" as their first free
  // candidate from the SAME once-per-tick Equipment snapshot (T-187 dual-
  // slot routing isn't re-run against commit-time state — a deliberate,
  // documented scope decision: the claim is TARGETED at the pre-picked
  // candidate, not a full re-scan across equippable.slots). The winner is
  // whichever the command loop processes first; the loser is REJECTED
  // (stays in inventory), never silently dropped or duplicated.
  assertEquals(eq.weapon?.prefabId, "stone_pickaxe", "first command claimed weapon");
  assertEquals(eq.offHand, null, "second command did not retry into off-hand");
  const remaining = w.get(actor, Inventory)!.slots;
  assertEquals(remaining.length, 1, "the losing item stayed in inventory — not lost, not duplicated");
  assertEquals(remaining[0], { kind: "stack", prefabId: "iron_sword", quantity: 1 });
});

Deno.test("T-344: MoveItem then Equip in one tick — Equip re-locates its item after the reshuffle instead of clobbering or grabbing the wrong slot", () => {
  const w = new World();
  const actor = newEntityId();
  w.create(actor);
  w.write(actor, Equipment, { ...EMPTY_EQUIP });
  w.write(actor, Inventory, {
    slots: [
      { kind: "stack", prefabId: "stone_pickaxe", quantity: 1 },
      { kind: "stack", prefabId: "berries", quantity: 3 },
    ],
    capacity: 20,
  });

  // MoveItem swaps slot 0 <-> slot 1 (pickaxe now at index 1); Equip still
  // names fromInventorySlot=0 — captured against the stale pre-tick view
  // (pickaxe), not the post-swap one. The fix must re-locate the CAPTURED
  // item by identity, not trust the index literally.
  runBatch(w, actor, [
    { cmd: CommandType.MoveItem, fromSlot: 0, toSlot: 1 },
    { cmd: CommandType.Equip, fromInventorySlot: 0 },
  ]);

  const eq = w.get(actor, Equipment)!;
  assertEquals(eq.weapon?.prefabId, "stone_pickaxe", "equip found the pickaxe wherever the swap left it");
  const remaining = w.get(actor, Inventory)!.slots;
  assertEquals(remaining.length, 1);
  assertEquals(remaining[0], { kind: "stack", prefabId: "berries", quantity: 3 }, "berries untouched, not corrupted by the stale index");
});

Deno.test("T-344: MoveItem then DropItem for the same player in one tick compose correctly", () => {
  const w = new World();
  const actor = newEntityId();
  w.create(actor);
  w.write(actor, Position, { x: 0, y: 0, z: 0 });
  w.write(actor, Equipment, { ...EMPTY_EQUIP });
  w.write(actor, Inventory, {
    slots: [
      { kind: "stack", prefabId: "stone_pickaxe", quantity: 1 },
      { kind: "stack", prefabId: "berries", quantity: 3 },
    ],
    capacity: 20,
  });

  // DropItem's item identity is captured from the SAME once-per-tick stale
  // Inventory read MoveItem also started from (fromSlot=0 → the pickaxe,
  // as it was when this tick's commands were read) — that's what gets
  // spawned on the ground. The removal side re-locates that captured
  // identity against commit-time state (findByIdentity's full-scan
  // fallback), so it correctly removes the pickaxe from wherever the
  // swap actually left it (index 1), not whatever now sits at the stale
  // index 0. The invariant under test is composition, not corruption:
  // exactly one item leaves the inventory, and it's the SAME one that was
  // spawned on the ground — never a mismatch, never both, never neither.
  runBatch(w, actor, [
    { cmd: CommandType.MoveItem, fromSlot: 0, toSlot: 1 },
    { cmd: CommandType.DropItem, fromSlot: 0 },
  ]);

  const remaining = w.get(actor, Inventory)!.slots;
  assertEquals(remaining.length, 1);
  assertEquals(remaining[0], { kind: "stack", prefabId: "berries", quantity: 3 }, "the pickaxe (the item actually dropped) is gone; berries (never touched by the drop) survived");
});

Deno.test("T-344: Unequip declines cleanly (no double-grant) when replayed twice for the same slot in one tick", () => {
  const w = new World();
  const actor = newEntityId();
  w.create(actor);
  const swordId = newEntityId();
  w.create(swordId);
  w.write(actor, Equipment, { ...EMPTY_EQUIP, weapon: { entityId: swordId, prefabId: "iron_sword" } });
  w.write(actor, Inventory, { slots: [], capacity: 20 });

  runBatch(w, actor, [
    { cmd: CommandType.Unequip, equipSlot: EquipSlotIndex.Weapon },
    { cmd: CommandType.Unequip, equipSlot: EquipSlotIndex.Weapon }, // replayed/duplicate command
  ]);

  const eq = w.get(actor, Equipment)!;
  assertEquals(eq.weapon, null);
  const slots = w.get(actor, Inventory)!.slots;
  assertEquals(slots.length, 1, "the sword was granted exactly once, not twice");
  assertEquals(slots[0], { kind: "unique", entityId: swordId });
});
