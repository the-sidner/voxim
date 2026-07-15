/**
 * Carried-item entity cleanup (T-252).
 *
 * spawnEquipEntity creates real item entities for every holder, but
 * nothing destroyed them with the holder — every NPC kill and player
 * disconnect leaked ItemData entities forever. Locks the fix: the
 * `equip_cleanup` death hook (and the disconnect path's shared helper)
 * destroy equipment + unique-inventory entities alongside the holder.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { Registry, World, EventBus } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { spawnPrefab, destroyCarriedItemEntities } from "./spawner.ts";
import { Equipment } from "./components/equipment.ts";
import { Inventory } from "./components/items.ts";
import { Bone } from "./components/bone.ts";
import { DeathSystem } from "./systems/death.ts";
import type { DeathHook } from "./systems/death.ts";

const content = await JsonSource.load();

Deno.test("T-252: killing an NPC destroys its equip entities (via the equip_cleanup hook)", () => {
  const world = new World();
  const wolf = spawnPrefab(world, content, "wolf", { x: 0, y: 0, z: 0 });
  const fang = world.get(wolf, Equipment)?.weapon?.entityId;
  assert(fang, "wolf spawned with a weapon entity");
  assert(world.isAlive(fang));

  const hooks = new Registry<DeathHook>();
  hooks.register({
    id: "equip_cleanup",
    onDeath: (ctx) => destroyCarriedItemEntities(ctx.world, ctx.entityId),
  });
  const deaths = new DeathSystem(hooks);
  deaths.request({ entityId: wolf, cause: "damage" });
  deaths.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();

  assert(!world.isAlive(wolf), "wolf destroyed");
  assert(!world.isAlive(fang), "its weapon entity went with it — no leak");
});

Deno.test("T-219: killing a skeletal NPC destroys its bone-entity subtree too (destroySubtree, not destroy)", () => {
  const world = new World();
  const wolf = spawnPrefab(world, content, "wolf", { x: 0, y: 0, z: 0 });
  const boneEntities = world.descendants(wolf).filter((d) => world.has(d, Bone));
  assertEquals(boneEntities.length, 11, "wolf spawned its full bone subtree");
  for (const b of boneEntities) assert(world.isAlive(b));

  const hooks = new Registry<DeathHook>();
  hooks.register({
    id: "equip_cleanup",
    onDeath: (ctx) => destroyCarriedItemEntities(ctx.world, ctx.entityId),
  });
  const deaths = new DeathSystem(hooks);
  deaths.request({ entityId: wolf, cause: "damage" });
  deaths.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();

  assert(!world.isAlive(wolf), "wolf destroyed");
  for (const b of boneEntities) {
    assert(!world.isAlive(b), `bone entity ${b} leaked past the wolf's own death`);
  }
});

Deno.test("T-252: unique inventory slots are destroyed too; stacks are untouched data", () => {
  const world = new World();
  const holder = world.create();
  const sword = world.create();
  world.write(holder, Inventory, {
    capacity: 8,
    slots: [
      { kind: "unique", entityId: sword },
      { kind: "stack", prefabId: "berries", quantity: 3 },
    ],
  });

  destroyCarriedItemEntities(world, holder);
  world.applyChangeset();
  assertEquals(world.isAlive(sword), false, "unique item entity destroyed");
  assert(world.isAlive(holder), "the helper never touches the holder itself");
});
