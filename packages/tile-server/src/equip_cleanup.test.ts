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
import { createShedDissolveHook } from "./deathhooks/shed_dissolve.ts";
import { StaleSlotCleanupSystem } from "./systems/stale_slot_cleanup.ts";

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

// T-366: a lingering (dissolve/crumble) corpse must not go on naming a
// destroyed item entity in its Equipment slots — the client's per-frame
// attachment anchor (resolveItemAttachment/syncEquipment in
// entity_mesh_registry.ts) would otherwise keep positioning a weapon/armor
// mesh with no backing entity for the corpse's whole linger window.
// equip_cleanup only DESTROYS the item entities (see its doc comment for
// why it deliberately doesn't also touch Equipment/Inventory itself);
// StaleSlotCleanupSystem (T-344) is the single generic owner of "null out
// a slot whose entity died" and runs FIRST every tick, so the dangling ref
// this hook leaves behind for exactly one tick gets scrubbed on the very
// next tick — before any *other* system or the outgoing delta can observe
// it. These tests drive both ticks, mirroring wiring.ts's real system
// order (StaleSlotCleanupSystem, ..., DeathSystem last).
Deno.test("T-366: a dissolve-styled corpse's Equipment has no slot referencing a destroyed entity id, one tick after death", () => {
  const world = new World();
  const drowner = spawnPrefab(world, content, "drowner", { x: 0, y: 0, z: 0 });
  const claws = world.get(drowner, Equipment)?.weapon?.entityId;
  assert(claws, "drowner spawned with a weapon entity (weaponItemType: drowner_claws)");
  assert(world.isAlive(claws));

  const hooks = new Registry<DeathHook>();
  hooks.register({
    id: "equip_cleanup",
    onDeath: (ctx) => destroyCarriedItemEntities(ctx.world, ctx.entityId),
  });
  hooks.register(createShedDissolveHook(content));
  const deaths = new DeathSystem(hooks);
  const staleSlots = new StaleSlotCleanupSystem();

  // Death tick: equip_cleanup destroys the weapon entity, shed_dissolve
  // votes {linger: true} — DeathSystem skips world.destroy() on the
  // holder itself, so the corpse (and its Equipment component) survive
  // past this tick, unlike the T-252 test above.
  deaths.request({ entityId: drowner, cause: "damage" });
  deaths.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();

  assert(world.isAlive(drowner), "dissolve-styled corpse lingers past DeathSystem instead of being destroyed");
  assert(!world.isAlive(claws), "its weapon entity was destroyed alongside it — no leak");
  assertEquals(
    world.get(drowner, Equipment)!.weapon?.entityId,
    claws,
    "still stale for the remainder of the death tick itself — StaleSlotCleanupSystem runs FIRST, not last",
  );

  // Next tick: StaleSlotCleanupSystem runs first (per wiring.ts) and finds
  // the weapon dead as of the previous tick's changeset apply.
  staleSlots.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();

  const eq = world.get(drowner, Equipment);
  assert(eq, "the lingering corpse still carries an Equipment component");
  for (const [slotName, slot] of Object.entries(eq!)) {
    assertEquals(slot, null, `corpse's Equipment.${slotName} must not reference a destroyed entity id`);
  }
});

Deno.test("T-366: a crumble-styled corpse's Equipment is scrubbed the same way — StaleSlotCleanupSystem is style-agnostic", () => {
  const world = new World();
  const wolf = spawnPrefab(world, content, "wolf", { x: 0, y: 0, z: 0 });
  const fang = world.get(wolf, Equipment)?.weapon?.entityId;
  assert(fang, "wolf spawned with a weapon entity");

  const hooks = new Registry<DeathHook>();
  hooks.register({
    id: "equip_cleanup",
    onDeath: (ctx) => destroyCarriedItemEntities(ctx.world, ctx.entityId),
  });
  // wolf.json's deathStyleId resolves to "crumble" — a real DeathStyleDef
  // lookup isn't needed here since crumble's own DeathHook (shed_crumble)
  // only seeds a timer + votes linger; StaleSlotCleanupSystem's Equipment
  // scrub is entirely style-agnostic, so simulating the linger vote
  // directly (without wiring shed_crumble) isolates exactly what this test
  // is pinning.
  hooks.register({ id: "shed_crumble_stub", onDeath: () => ({ linger: true }) });
  const deaths = new DeathSystem(hooks);
  const staleSlots = new StaleSlotCleanupSystem();

  deaths.request({ entityId: wolf, cause: "damage" });
  deaths.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();

  assert(world.isAlive(wolf), "crumble-styled corpse lingers past DeathSystem instead of being destroyed");
  assert(!world.isAlive(fang), "its weapon entity was destroyed alongside it — no leak");

  staleSlots.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();

  assertEquals(world.get(wolf, Equipment)!.weapon, null, "crumble corpse's Equipment.weapon must not reference a destroyed entity id");
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
