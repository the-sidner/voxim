/**
 * StaleSlotCleanupSystem (T-344) — scrubs dead entity refs out of Inventory
 * and Equipment via world.mutate, not get-then-set, so this system composes
 * correctly with every OTHER writer of those two components in the same
 * tick instead of clobbering them (it runs first in the declared tick
 * order per its own doc comment, but per T-249/T-344 doctrine correctness
 * must not depend on that ordering — mutate is what actually guarantees it).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { Inventory } from "../components/items.ts";
import { Equipment } from "../components/equipment.ts";
import type { EquipmentData } from "../components/equipment.ts";
import { StaleSlotCleanupSystem } from "./stale_slot_cleanup.ts";

const EMPTY_EQUIP: EquipmentData = {
  weapon: null, offHand: null, head: null, chest: null, legs: null, feet: null, back: null,
};

function run(world: World): void {
  new StaleSlotCleanupSystem().run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
}

Deno.test("a dead unique inventory slot is scrubbed; a live one survives untouched", () => {
  const world = new World();
  const owner = newEntityId();
  world.create(owner);
  const dead = newEntityId();
  world.create(dead);
  const alive = newEntityId();
  world.create(alive);
  world.write(owner, Inventory, {
    slots: [
      { kind: "unique", entityId: dead },
      { kind: "unique", entityId: alive },
      { kind: "stack", prefabId: "berries", quantity: 3 },
    ],
    capacity: 20,
  });
  world.destroy(dead);
  world.applyChangeset(); // dead is gone as of the START of the tick StaleSlotCleanup scrubs

  run(world);

  const slots = world.get(owner, Inventory)!.slots;
  assertEquals(slots.length, 2);
  assert(slots.some((s) => s.kind === "unique" && s.entityId === alive), "live unique ref kept");
  assert(slots.some((s) => s.kind === "stack" && s.prefabId === "berries"), "stack untouched");
  assert(!slots.some((s) => s.kind === "unique" && s.entityId === dead), "dead ref scrubbed");
});

Deno.test("a dead equipped entity's slot is nulled; a live one survives untouched", () => {
  const world = new World();
  const owner = newEntityId();
  world.create(owner);
  const deadWeapon = newEntityId();
  world.create(deadWeapon);
  const aliveHelmet = newEntityId();
  world.create(aliveHelmet);
  world.write(owner, Equipment, {
    ...EMPTY_EQUIP,
    weapon: { entityId: deadWeapon, prefabId: "stone_axe" },
    head: { entityId: aliveHelmet, prefabId: "cloth_hood" },
  });
  world.destroy(deadWeapon);
  world.applyChangeset();

  run(world);

  const eq = world.get(owner, Equipment)!;
  assertEquals(eq.weapon, null, "dead weapon ref cleared");
  assertEquals(eq.head?.entityId, aliveHelmet, "live head ref kept");
});

Deno.test("a no-op tick (nothing dead) never issues a write", () => {
  const world = new World();
  const owner = newEntityId();
  world.create(owner);
  const alive = newEntityId();
  world.create(alive);
  world.write(owner, Inventory, { slots: [{ kind: "unique", entityId: alive }], capacity: 20 });
  const versionBefore = world.getVersion(owner, Inventory);

  run(world);

  assertEquals(world.getVersion(owner, Inventory), versionBefore, "no dead refs — no write, no version bump");
});

Deno.test("T-344: the scrub composes with a same-tick appender instead of clobbering it (mutate, not get-then-set)", () => {
  const world = new World();
  const owner = newEntityId();
  world.create(owner);
  const dead = newEntityId();
  world.create(dead);
  world.write(owner, Inventory, { slots: [{ kind: "unique", entityId: dead }], capacity: 20 });
  world.destroy(dead);
  world.applyChangeset();

  // Simulate a second same-tick writer (e.g. DebugCommandSystem's give path)
  // appending to the SAME Inventory this SAME tick, via world.mutate — the
  // only way that composes correctly with StaleSlotCleanup's own write.
  new StaleSlotCleanupSystem().run(world, new EventBus(), 1 / 20);
  world.mutate(owner, Inventory, (cur) => ({
    ...cur,
    slots: [...cur.slots, { kind: "stack" as const, prefabId: "berries", quantity: 1 }],
  }));
  world.applyChangeset();

  const slots = world.get(owner, Inventory)!.slots;
  assertEquals(slots.length, 1, "the dead ref was scrubbed AND the new stack landed — neither clobbered the other");
  assertEquals(slots[0], { kind: "stack", prefabId: "berries", quantity: 1 });
});
