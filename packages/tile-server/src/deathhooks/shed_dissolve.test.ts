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
import { StaticContentStore } from "@voxim/content";
import type { NpcTemplate, DissolveProfileDef } from "@voxim/content";
import { Health } from "../components/game.ts";
import { NpcTag } from "../components/npcs.ts";
import { Resource } from "../components/resource.ts";
import { DeathSystem } from "../systems/death.ts";
import type { DeathHook } from "../systems/death.ts";
import { createShedDissolveHook } from "./shed_dissolve.ts";
import { ResourceSystem } from "../systems/resource.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { newResourceEffectRegistry } from "../resources/effect.ts";
import { newResourceModifierRegistry } from "../resources/modifier.ts";
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

const rotTemplate: NpcTemplate = {
  id: "test_drowner",
  displayName: "Test Drowner",
  maxHealth: 55,
  fleeHealthRatio: 0,
  behaviorTreeId: "hostile",
  dissolveProfileId: "test_rot",
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
