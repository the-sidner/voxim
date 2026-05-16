/**
 * Hunger/Thirst as Resources (T-238c).
 *
 * Real content (data/resources/hunger.json) + ResourceSystem wired with
 * the real emit_event + modify_health effects. Locks the cross→event and
 * sustained→health-damage couplings the retired HungerSystem owned.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import { Resource } from "../components/resource.ts";
import { Health } from "../components/game.ts";
import { ResourceSystem } from "./resource.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { newResourceEffectRegistry } from "../resources/effect.ts";
import { newResourceModifierRegistry } from "../resources/modifier.ts";
import { modifyHealthEffect } from "../resources/effects/modify_health.ts";
import { emitEventEffect } from "../resources/effects/emit_event.ts";
import type { DeathRequestPort } from "../events/death.ts";

const DT = 1 / 20;
const content = await JsonSource.load();

function sys(deaths: DeathRequestPort) {
  const fx = newResourceEffectRegistry();
  fx.register(modifyHealthEffect);
  fx.register(emitEventEffect);
  return new ResourceSystem(content, fx, newResourceModifierRegistry(), deaths, newModifierSourceRegistry());
}

Deno.test("hunger crossing 80 publishes HungerCritical exactly once", () => {
  const deaths: DeathRequestPort = { request: () => {} };
  const s = sys(deaths);
  const w = new World();
  const id = newEntityId();
  w.create(id);
  w.write(id, Resource, { values: { hunger: { value: 79.9, max: 100 } } });
  w.write(id, Health, { current: 100, max: 100 });

  let criticals = 0;
  let lastEntity = "";
  for (let i = 0; i < 400; i++) {
    const bus = new EventBus();
    bus.subscribe(TileEvents.HungerCritical, (p: { entityId: string }) => {
      criticals++; lastEntity = p.entityId;
    });
    s.run(w, bus, DT);
    w.applyChangeset();
  }

  assert(w.get(id, Resource)!.values.hunger.value >= 80, "hunger climbed past 80");
  assertEquals(criticals, 1); // cross fires once, not every in-zone tick
  assertEquals(lastEntity, id);
  assertEquals(w.get(id, Health)!.current, 100); // < 100 hunger → no starvation
});

Deno.test("hunger pinned at 100 deals sustained starvation damage + death", () => {
  let deathReqs = 0;
  const deaths: DeathRequestPort = { request: () => { deathReqs++; } };
  const s = sys(deaths);
  const w = new World();
  const id = newEntityId();
  w.create(id);
  w.write(id, Resource, { values: { hunger: { value: 99.95, max: 100 } } });
  w.write(id, Health, { current: 6, max: 100 });

  for (let i = 0; i < 4000; i++) {
    s.run(w, new EventBus(), DT);
    w.applyChangeset();
  }

  assertEquals(w.get(id, Resource)!.values.hunger.value, 100); // clamped
  assertEquals(w.get(id, Health)!.current, 0); // starvationDps drained it
  assert(deathReqs >= 1, "death requested when health hit 0");
});
