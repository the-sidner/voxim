/**
 * shed_dissolve DeathHook tests (T-311 P5c).
 *
 * Mirrors bossfight.test.ts's DeathHook-ordering shape: the hook must see
 * NpcTag/resolve the profile BEFORE any destroy, and — the new behaviour —
 * `world.isAlive` must stay TRUE after `DeathSystem.run()` when the hook
 * votes `{ linger: true }`, with `dissolve_timer` correctly seeded. A
 * sibling ResourceSystem integration test confirms the timer decays and
 * `destroy_self` fires (removing the corpse) at the terminal threshold —
 * same shape as resource.test.ts's `lifetime` test.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId, Registry } from "@voxim/engine";
import { StaticContentStore, JsonSource } from "@voxim/content";
import type { NpcTemplate, DissolveProfileDef, DeathStyleDef } from "@voxim/content";
import { Health } from "../components/game.ts";
import { NpcTag } from "../components/npcs.ts";
import { Resource } from "../components/resource.ts";
import { Bone } from "../components/bone.ts";
import { DeathSystem } from "../systems/death.ts";
import type { DeathHook } from "../systems/death.ts";
import { createShedDissolveHook } from "./shed_dissolve.ts";
import { spawnPrefab, destroyCarriedItemEntities } from "../spawner.ts";
import { ResourceSystem } from "../systems/resource.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { newResourceEffectRegistry } from "../resources/effect.ts";
import { newResourceModifierRegistry } from "../resources/modifier.ts";
import { equipmentStatModifier } from "../resources/modifiers/equipment_stat.ts";
import { destroySelfEffect } from "../resources/effects/destroy_self.ts";
import type { DeathRequestPort } from "../events/death.ts";

const DT = 1 / 20;
const noDeaths: DeathRequestPort = { request: () => {} };

const rotProfile: DissolveProfileDef = {
  id: "test_rot",
  frayBandWidth: 0.35,
  driftSpeed: 0.6,
  maxSeparatedVoxels: 48,
  maxSeparationDistance: 1.4,
  durationTicks: 4,
  phaseCurve: "linear",
};

const rotStyle: DeathStyleDef = {
  id: "test_dissolve_style",
  style: "dissolve",
  resourceKey: "dissolve_timer",
  dissolveProfileId: "test_rot",
};

const rotTemplate: NpcTemplate = {
  id: "test_drowner",
  displayName: "Test Drowner",
  maxHealth: 55,
  fleeHealthRatio: 0,
  behaviorTreeId: "hostile",
  deathStyleId: "test_dissolve_style",
};

const plainTemplate: NpcTemplate = {
  id: "test_villager",
  displayName: "Test Villager",
  maxHealth: 40,
  fleeHealthRatio: 0.3,
  behaviorTreeId: "passive",
};

function newContent(): StaticContentStore {
  const c = new StaticContentStore();
  c.registerDissolveProfile(rotProfile);
  c.registerDeathStyle(rotStyle);
  c.registerNpcTemplate(rotTemplate);
  c.registerNpcTemplate(plainTemplate);
  return c;
}

Deno.test("shed_dissolve: a profiled NPC's death defers world.destroy and seeds dissolve_timer", () => {
  const content = newContent();
  const world = new World();
  const events = new EventBus();

  const id = newEntityId();
  world.create(id);
  world.write(id, Health, { current: 0, max: 55 });
  world.write(id, NpcTag, { npcType: "test_drowner", name: "Drowner" });

  const hooks = new Registry<DeathHook>();
  hooks.register(createShedDissolveHook(content));
  const death = new DeathSystem(hooks);

  death.run(world, events, DT); // Health<=0 sweep requests death this same run.
  world.applyChangeset();

  assertEquals(world.isAlive(id), true, "a profiled corpse lingers past DeathSystem instead of being destroyed");
  const rv = world.get(id, Resource)?.values["dissolve_timer"];
  assert(rv, "dissolve_timer Resource must be seeded");
  assertEquals(rv!.value, 4);
  assertEquals(rv!.max, 4);
});

Deno.test("shed_dissolve: a non-profiled NPC's death is unaffected (destroyed same tick, no dissolve_timer)", () => {
  const content = newContent();
  const world = new World();
  const events = new EventBus();

  const id = newEntityId();
  world.create(id);
  world.write(id, Health, { current: 0, max: 40 });
  world.write(id, NpcTag, { npcType: "test_villager", name: "Villager" });

  const hooks = new Registry<DeathHook>();
  hooks.register(createShedDissolveHook(content));
  const death = new DeathSystem(hooks);

  death.run(world, events, DT);
  world.applyChangeset();

  assertEquals(world.isAlive(id), false, "default (non-profiled) death behaviour is unchanged — destroyed same tick");
});

Deno.test("shed_dissolve: a player entity (no NpcTag) is unaffected — hook no-ops without a template", () => {
  const content = newContent();
  const world = new World();
  const events = new EventBus();

  const id = newEntityId();
  world.create(id);
  world.write(id, Health, { current: 0, max: 100 });
  // No NpcTag — this is what a player entity's death looks like to the hook.

  const hooks = new Registry<DeathHook>();
  hooks.register(createShedDissolveHook(content));
  const death = new DeathSystem(hooks);

  death.run(world, events, DT);
  world.applyChangeset();

  assertEquals(world.isAlive(id), false, "players never carry NpcTag — always destroyed same tick as before");
});

Deno.test("shed_dissolve: the health<=0 sweep must not re-kill a lingering corpse (dissolve_timer decays under the REAL tick loop)", () => {
  // Live-found bug (T-311 P5c I3b measurement): a lingering corpse keeps
  // Health.current = 0, so DeathSystem's composed-lethal sweep re-requested
  // its death EVERY tick — re-running shed_dissolve, whose world.set re-seeded
  // dissolve_timer back to full AFTER ResourceSystem's decrement in the same
  // tick's op-log. Net: the timer sat pinned at max forever and no corpse
  // ever dissolved. The sibling tests missed it because none re-ran
  // DeathSystem after the linger vote. This test drives the real per-tick
  // system order (ResourceSystem then DeathSystem, one changeset per tick).
  const content = newContent();
  content.registerResource({
    id: "dissolve_timer", scope: "entity", bounds: { min: 0, max: 1 }, rate: -20,
    thresholds: [{ at: 0, dir: "below", edge: "cross", effect: "destroy_self" }],
  });
  const fx = newResourceEffectRegistry();
  fx.register(destroySelfEffect);
  const resources = new ResourceSystem(content, fx, newResourceModifierRegistry(), noDeaths, newModifierSourceRegistry());
  const hooks = new Registry<DeathHook>();
  hooks.register(createShedDissolveHook(content));
  const death = new DeathSystem(hooks);

  const world = new World();
  const events = new EventBus();
  const id = newEntityId();
  world.create(id);
  world.write(id, Health, { current: 0, max: 55 });
  world.write(id, NpcTag, { npcType: "test_drowner", name: "Drowner" });

  function tick(): void {
    resources.run(world, events, DT);
    death.run(world, events, DT);
    world.applyChangeset();
  }

  tick(); // death sweep fires, hook seeds dissolve_timer = 4/4, linger vote
  assertEquals(world.isAlive(id), true);
  assertEquals(world.get(id, Resource)!.values.dissolve_timer.value, 4);

  tick(); // ResourceSystem 4 -> 3; the sweep must NOT re-seed it back to 4
  assertEquals(world.get(id, Resource)!.values.dissolve_timer.value, 3,
    "a lingering corpse's dissolve_timer must decay — the health<=0 sweep re-killed it and re-seeded the timer");

  tick(); // 3 -> 2
  tick(); // 2 -> 1
  assert(world.isAlive(id), "still lingering one tick before the terminal cross");
  tick(); // 1 -> 0: crosses below 0, destroy_self removes the corpse
  assertEquals(world.isAlive(id), false, "corpse removed exactly once the timer finishes");
});

Deno.test("dissolve_timer: cross@0 -> destroy_self removes the lingering corpse once the dissolve finishes", () => {
  const content = newContent();
  content.registerResource({
    id: "dissolve_timer", scope: "entity", bounds: { min: 0, max: 1 }, rate: -20,
    thresholds: [{ at: 0, dir: "below", edge: "cross", effect: "destroy_self" }],
  });
  const fx = newResourceEffectRegistry();
  fx.register(destroySelfEffect);
  const sys = new ResourceSystem(content, fx, newResourceModifierRegistry(), noDeaths, newModifierSourceRegistry());

  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, Resource, { values: { dissolve_timer: { value: 4, max: 4 } } }); // 4 ticks (matches durationTicks above)

  function tick(): void {
    sys.run(world, new EventBus(), DT);
    world.applyChangeset();
  }

  tick(); // 4 -> 3
  assert(world.isAlive(id));
  assertEquals(world.get(id, Resource)!.values.dissolve_timer.value, 3);
  tick(); // 3 -> 2
  tick(); // 2 -> 1
  assert(world.isAlive(id), "still lingering one tick before the terminal cross");
  tick(); // 1 -> 0: crosses below 0, destroy_self fires
  assertEquals(world.isAlive(id), false, "corpse removed exactly once the timer finishes");
});

// ---- T-219 regression: destroy_self must not orphan a dissolving skeletal
// corpse's bone-entity subtree ------------------------------------------------
//
// A real skeletal NPC (drowner, biped_skeletal, 17 bones + dissolveProfileId
// "drowner_rot") whose death lingers via shed_dissolve: DeathSystem skips its
// own destroySubtree for the linger vote, and dissolve_timer's terminal
// cross@0 -> destroy_self is the ONLY remaining teardown. Before this fix,
// destroy_self called a bare world.destroy() on just the corpse root, so
// every one of its 17 bone entities (parented onto it since spawn) survived
// forever, orphaned — the exact leak class this arc's own destroy ->
// destroySubtree conversions (death.ts, server.ts, poi.ts) were meant to
// close everywhere, minus this one path.
Deno.test("T-219: destroy_self removes a dissolved skeletal corpse's ENTIRE bone-entity subtree, not just the root", async () => {
  const content = await JsonSource.load();

  const world = new World();
  const drowner = spawnPrefab(world, content, "drowner", { x: 0, y: 0, z: 0 });
  const boneEntities = world.descendants(drowner).filter((d) => world.has(d, Bone));
  assert(boneEntities.length > 0, "drowner (biped_skeletal) spawned a real bone-entity subtree");
  for (const b of boneEntities) assert(world.isAlive(b));

  const hooks = new Registry<DeathHook>();
  hooks.register({
    id: "equip_cleanup",
    onDeath: (ctx) => destroyCarriedItemEntities(ctx.world, ctx.entityId),
  });
  hooks.register(createShedDissolveHook(content));
  const resourceEffects = newResourceEffectRegistry();
  resourceEffects.register(destroySelfEffect);
  const resourceModifiers = newResourceModifierRegistry();
  resourceModifiers.register(equipmentStatModifier);
  const death = new DeathSystem(hooks);
  const resources = new ResourceSystem(
    content, resourceEffects, resourceModifiers, death, newModifierSourceRegistry(),
  );

  world.write(drowner, Health, { current: 0, max: content.npcTemplates.get("drowner")!.maxHealth });

  function tick(): void {
    resources.run(world, new EventBus(), DT);
    death.run(world, new EventBus(), DT);
    world.applyChangeset();
  }

  tick(); // death sweep fires, shed_dissolve seeds dissolve_timer, votes linger
  assert(world.isAlive(drowner), "corpse lingers past DeathSystem");
  const durationTicks = world.get(drowner, Resource)!.values.dissolve_timer.max;
  assert(durationTicks > 0);
  for (const b of boneEntities) assert(world.isAlive(b), "bones survive while the corpse is still dissolving");

  // Run past the dissolve timer's terminal cross@0.
  for (let i = 0; i < durationTicks + 2; i++) tick();

  assert(!world.isAlive(drowner), "corpse fully dissolved");
  for (const b of boneEntities) {
    assert(!world.isAlive(b), `bone entity ${b} leaked past its corpse's dissolve — destroy_self must destroySubtree`);
  }
});
