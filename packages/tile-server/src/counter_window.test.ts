/**
 * CounterReady window expiry (T-250) — the parry bonus is a server-only flag
 * bounded by a `counter_window` Resource. When the window elapses (cross@0)
 * the `clear_counter_ready` effect drops the flag, so an unconsumed counter no
 * longer latches forever (the pre-T-250 bug). Primitives composing: a combat
 * presence-flag expired by the Resource lifetime mechanism.
 */

import { assert } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { StaticContentStore } from "@voxim/content";
import type { ResourceDef } from "@voxim/content";
import { Resource } from "./components/resource.ts";
import { CounterReady } from "./components/combat.ts";
import { ResourceSystem } from "./systems/resource.ts";
import { newModifierSourceRegistry } from "./modifiers/modifier.ts";
import { newResourceEffectRegistry } from "./resources/effect.ts";
import { newResourceModifierRegistry } from "./resources/modifier.ts";
import { clearCounterReadyEffect } from "./resources/effects/clear_counter_ready.ts";
import type { DeathRequestPort } from "./events/death.ts";

const DT = 1 / 20;
const noDeaths: DeathRequestPort = { request: () => {} };

const COUNTER_WINDOW: ResourceDef = {
  id: "counter_window",
  scope: "entity",
  bounds: { min: 0, max: 1 },
  rate: -20, // -1 / tick
  thresholds: [{ at: 0, dir: "below", edge: "cross", effect: "clear_counter_ready" }],
};

Deno.test("T-250: counter_window cross@0 clears the CounterReady flag", () => {
  const store = new StaticContentStore();
  store.registerResource(COUNTER_WINDOW);
  const effects = newResourceEffectRegistry();
  effects.register(clearCounterReadyEffect);
  const sys = new ResourceSystem(
    store, effects, newResourceModifierRegistry(), noDeaths, newModifierSourceRegistry(),
  );

  const world = new World();
  const id = newEntityId();
  world.create(id);
  // Parry just landed: flag set + a 1-tick window for a fast test.
  world.write(id, CounterReady, {});
  world.write(id, Resource, { values: { counter_window: { value: 1, max: 1 } } });

  assert(world.has(id, CounterReady), "flag present right after the parry");

  sys.run(world, new EventBus(), DT);
  world.applyChangeset();

  assert(!world.has(id, CounterReady), "window elapsed → flag dropped, not latched");
});
