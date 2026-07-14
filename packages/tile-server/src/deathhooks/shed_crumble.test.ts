/**
 * shed_crumble DeathHook tests (T-339). Mirrors shed_dissolve.test.ts's
 * shape exactly — same ordering guarantees, same linger contract, same
 * T-219 destroySubtree regression, ported onto crumble's own resourceKey.
 * Two additional tests here (not in shed_dissolve.test.ts) pin the
 * mutual-exclusivity property once BOTH hooks are registered together —
 * the real boot shape (server.ts registers both).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId, Registry } from "@voxim/engine";
import { StaticContentStore, JsonSource } from "@voxim/content";
import type { NpcTemplate, DeathStyleDef } from "@voxim/content";
import { Health } from "../components/game.ts";
import { NpcTag } from "../components/npcs.ts";
import { Resource } from "../components/resource.ts";
import { Bone } from "../components/bone.ts";
import { DeathSystem } from "../systems/death.ts";
import type { DeathHook } from "../systems/death.ts";
import { createShedCrumbleHook } from "./shed_crumble.ts";
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

const crumbleStyle: DeathStyleDef = {
  id: "test_crumble_style",
  style: "crumble",
  resourceKey: "crumble_timer",
  crumble: {
    impulseSpeed: [1.5, 3.5],
    spreadDeg: 50,
    gravityScale: 1.0,
    spinSpeed: [1.0, 4.0],
    durationTicks: 4,
    fadeTicks: 1,
    impactParticleId: "test_crumble_impact",
  },
};

const dissolveStyle: DeathStyleDef = {
  id: "test_dissolve_style_2",
  style: "dissolve",
  resourceKey: "dissolve_timer",
  dissolveProfileId: "test_rot_2",
};

const crumbleTemplate: NpcTemplate = {
  id: "test_bandit",
  displayName: "Test Bandit",
  maxHealth: 100,
  fleeHealthRatio: 0.1,
  behaviorTreeId: "hostile",
  deathStyleId: "test_crumble_style",
};

const dissolveTemplate: NpcTemplate = {
  id: "test_drowner_2",
  displayName: "Test Drowner 2",
  maxHealth: 55,
  fleeHealthRatio: 0,
  behaviorTreeId: "hostile",
  deathStyleId: "test_dissolve_style_2",
};

const plainTemplate: NpcTemplate = {
  id: "test_villager_2",
  displayName: "Test Villager 2",
  maxHealth: 40,
  fleeHealthRatio: 0.3,
  behaviorTreeId: "passive",
};

function newContent(): StaticContentStore {
  const c = new StaticContentStore();
  c.registerDeathStyle(crumbleStyle);
  c.registerNpcTemplate(crumbleTemplate);
  c.registerNpcTemplate(plainTemplate);
  return c;
}

Deno.test("shed_crumble: a crumble-styled NPC's death defers world.destroy and seeds crumble_timer", () => {
  const content = newContent();
  const world = new World();
  const events = new EventBus();

  const id = newEntityId();
  world.create(id);
  world.write(id, Health, { current: 0, max: 100 });
  world.write(id, NpcTag, { npcType: "test_bandit", name: "Bandit" });

  const hooks = new Registry<DeathHook>();
  hooks.register(createShedCrumbleHook(content));
  const death = new DeathSystem(hooks);

  death.run(world, events, DT); // Health<=0 sweep requests death this same run.
  world.applyChangeset();

  assertEquals(world.isAlive(id), true, "a crumble-styled corpse lingers past DeathSystem instead of being destroyed");
  const rv = world.get(id, Resource)?.values["crumble_timer"];
  assert(rv, "crumble_timer Resource must be seeded");
  assertEquals(rv!.value, 4);
  assertEquals(rv!.max, 4);
});

Deno.test("shed_crumble: a non-styled NPC's death is unaffected (destroyed same tick, no crumble_timer)", () => {
  const content = newContent();
  const world = new World();
  const events = new EventBus();

  const id = newEntityId();
  world.create(id);
  world.write(id, Health, { current: 0, max: 40 });
  world.write(id, NpcTag, { npcType: "test_villager_2", name: "Villager" });

  const hooks = new Registry<DeathHook>();
  hooks.register(createShedCrumbleHook(content));
  const death = new DeathSystem(hooks);

  death.run(world, events, DT);
  world.applyChangeset();

  assertEquals(world.isAlive(id), false, "default (non-styled) death behaviour is unchanged — destroyed same tick");
});

Deno.test("shed_crumble: a player entity (no NpcTag) is unaffected — hook no-ops without a template", () => {
  const content = newContent();
  const world = new World();
  const events = new EventBus();

  const id = newEntityId();
  world.create(id);
  world.write(id, Health, { current: 0, max: 100 });
  // No NpcTag — this is what a player entity's death looks like to the hook.

  const hooks = new Registry<DeathHook>();
  hooks.register(createShedCrumbleHook(content));
  const death = new DeathSystem(hooks);

  death.run(world, events, DT);
  world.applyChangeset();

  assertEquals(world.isAlive(id), false, "players never carry NpcTag — always destroyed same tick as before");
});

Deno.test("shed_crumble: the health<=0 sweep must not re-kill a lingering corpse (crumble_timer decays under the REAL tick loop)", () => {
  // Same shape as shed_dissolve's pinned regression (T-311 P5c I3b) — pinned
  // here too since crumble shares the exact same linger/re-seed hazard.
  const content = newContent();
  content.registerResource({
    id: "crumble_timer", scope: "entity", bounds: { min: 0, max: 1 }, rate: -20,
    thresholds: [{ at: 0, dir: "below", edge: "cross", effect: "destroy_self" }],
  });
  const fx = newResourceEffectRegistry();
  fx.register(destroySelfEffect);
  const resources = new ResourceSystem(content, fx, newResourceModifierRegistry(), noDeaths, newModifierSourceRegistry());
  const hooks = new Registry<DeathHook>();
  hooks.register(createShedCrumbleHook(content));
  const death = new DeathSystem(hooks);

  const world = new World();
  const events = new EventBus();
  const id = newEntityId();
  world.create(id);
  world.write(id, Health, { current: 0, max: 100 });
  world.write(id, NpcTag, { npcType: "test_bandit", name: "Bandit" });

  function tick(): void {
    resources.run(world, events, DT);
    death.run(world, events, DT);
    world.applyChangeset();
  }

  tick(); // death sweep fires, hook seeds crumble_timer = 4/4, linger vote
  assertEquals(world.isAlive(id), true);
  assertEquals(world.get(id, Resource)!.values.crumble_timer.value, 4);

  tick(); // ResourceSystem 4 -> 3; the sweep must NOT re-seed it back to 4
  assertEquals(world.get(id, Resource)!.values.crumble_timer.value, 3,
    "a lingering corpse's crumble_timer must decay — the health<=0 sweep re-killed it and re-seeded the timer");

  tick(); // 3 -> 2
  tick(); // 2 -> 1
  assert(world.isAlive(id), "still lingering one tick before the terminal cross");
  tick(); // 1 -> 0: crosses below 0, destroy_self removes the corpse
  assertEquals(world.isAlive(id), false, "corpse removed exactly once the timer finishes");
});

Deno.test("shed_dissolve + shed_crumble registered together: each death seeds exactly ITS OWN timer key, never both", () => {
  const content = new StaticContentStore();
  content.registerDissolveProfile({
    id: "test_rot_2", frayBandWidth: 0.35, driftSpeed: 0.6,
    maxSeparatedVoxels: 48, maxSeparationDistance: 1.4, durationTicks: 4, phaseCurve: "linear",
  });
  content.registerDeathStyle(dissolveStyle);
  content.registerDeathStyle(crumbleStyle);
  content.registerNpcTemplate(dissolveTemplate);
  content.registerNpcTemplate(crumbleTemplate);

  const hooks = new Registry<DeathHook>();
  hooks.register(createShedDissolveHook(content));
  hooks.register(createShedCrumbleHook(content));
  const death = new DeathSystem(hooks);

  const world = new World();
  const events = new EventBus();

  const dissolveId = newEntityId();
  world.create(dissolveId);
  world.write(dissolveId, Health, { current: 0, max: 55 });
  world.write(dissolveId, NpcTag, { npcType: "test_drowner_2", name: "Drowner" });

  const crumbleId = newEntityId();
  world.create(crumbleId);
  world.write(crumbleId, Health, { current: 0, max: 100 });
  world.write(crumbleId, NpcTag, { npcType: "test_bandit", name: "Bandit" });

  death.run(world, events, DT);
  world.applyChangeset();

  const dissolveValues = world.get(dissolveId, Resource)!.values;
  assert(dissolveValues["dissolve_timer"], "dissolve-styled entity must carry dissolve_timer");
  assertEquals(dissolveValues["crumble_timer"], undefined, "dissolve-styled entity must NOT carry crumble_timer");

  const crumbleValues = world.get(crumbleId, Resource)!.values;
  assert(crumbleValues["crumble_timer"], "crumble-styled entity must carry crumble_timer");
  assertEquals(crumbleValues["dissolve_timer"], undefined, "crumble-styled entity must NOT carry dissolve_timer");
});

// ---- T-219 regression, repeated for crumble: destroy_self must not orphan
// a crumbling skeletal corpse's bone-entity subtree -------------------------
Deno.test("T-219 (crumble): destroy_self removes a crumbled skeletal corpse's ENTIRE bone-entity subtree, not just the root", async () => {
  const content = await JsonSource.load();

  const world = new World();
  const bandit = spawnPrefab(world, content, "bandit", { x: 0, y: 0, z: 0 });
  const boneEntities = world.descendants(bandit).filter((d) => world.has(d, Bone));
  assert(boneEntities.length > 0, "bandit (biped_skeletal) spawned a real bone-entity subtree");
  for (const b of boneEntities) assert(world.isAlive(b));

  const hooks = new Registry<DeathHook>();
  hooks.register({
    id: "equip_cleanup",
    onDeath: (ctx) => destroyCarriedItemEntities(ctx.world, ctx.entityId),
  });
  hooks.register(createShedCrumbleHook(content));
  const resourceEffects = newResourceEffectRegistry();
  resourceEffects.register(destroySelfEffect);
  const resourceModifiers = newResourceModifierRegistry();
  resourceModifiers.register(equipmentStatModifier);
  const death = new DeathSystem(hooks);
  const resources = new ResourceSystem(
    content, resourceEffects, resourceModifiers, death, newModifierSourceRegistry(),
  );

  world.write(bandit, Health, { current: 0, max: content.npcTemplates.get("bandit")!.maxHealth });

  function tick(): void {
    resources.run(world, new EventBus(), DT);
    death.run(world, new EventBus(), DT);
    world.applyChangeset();
  }

  tick(); // death sweep fires, shed_crumble seeds crumble_timer, votes linger
  assert(world.isAlive(bandit), "corpse lingers past DeathSystem");
  const durationTicks = world.get(bandit, Resource)!.values.crumble_timer.max;
  assert(durationTicks > 0);
  for (const b of boneEntities) assert(world.isAlive(b), "bones survive while the corpse is still crumbling");

  // Run past the crumble timer's terminal cross@0.
  for (let i = 0; i < durationTicks + 2; i++) tick();

  assert(!world.isAlive(bandit), "corpse fully torn down");
  for (const b of boneEntities) {
    assert(!world.isAlive(b), `bone entity ${b} leaked past its corpse's crumble — destroy_self must destroySubtree`);
  }
});
