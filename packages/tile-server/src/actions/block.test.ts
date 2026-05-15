/**
 * block action substrate (T-233).
 *
 * The parry window now derives from the held `block` action's primary-slot
 * `ticksInPhase` (no BlockHeld counter / CombatTimersSystem). This locks
 * the contract that derivation depends on: `block` installs the `blocking`
 * tag on hold:enter, its perpetual `hold` phase counts up while held, and
 * the tag clears when the slot leaves block.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { Blocking } from "../components/tags.ts";
import { ActionDispatcher } from "./dispatcher.ts";
import type { IntentResolver } from "./dispatcher.ts";
import { newGateRegistry } from "./gate.ts";
import { newEffectRegistry } from "./effect.ts";
import { setTagResolver, clearTagResolver } from "./resolvers/tags.ts";

const content = await JsonSource.load();

function actor(world: World): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["primary"] });
  world.write(id, ActiveActions, { states: {} });
  return id;
}

/** Wants block for the first `holdTicks` resolves, then releases. */
function blockThenRelease(holdTicks: number): IntentResolver {
  let n = 0;
  return {
    resolve: () =>
      new Map([["primary", n++ < holdTicks ? "block" : "primary_idle"]]),
  };
}

Deno.test("block: blocking tag + perpetual hold ticksInPhase drives the parry window", () => {
  const world = new World();
  const id = actor(world);
  const effects = newEffectRegistry();
  effects.register(setTagResolver);
  effects.register(clearTagResolver);
  const d = new ActionDispatcher(content, newGateRegistry(), effects, blockThenRelease(5));

  // Tick 0: block starts → hold:enter set_tag blocking, ticksInPhase 0.
  d.prepare(0);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assert(world.has(id, Blocking), "blocking tag set on hold:enter");
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.actionId, "block");
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.ticksInPhase, 0);

  // Perpetual hold phase accrues ticksInPhase each tick held — this value
  // is exactly what health_hit_handler reads for the parry window.
  for (let t = 1; t < 4; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
    assertEquals(world.get(id, ActiveActions)?.states["primary"]?.ticksInPhase, t);
    assert(world.has(id, Blocking), `still blocking at tick ${t}`);
  }

  // Release: intent swaps to primary_idle; block's hold cancel-into ["any"]
  // lets it go, hold:exit clears the tag.
  for (let t = 4; t < 8; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
  }
  assert(!world.has(id, Blocking), "blocking tag cleared after release");
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.actionId, "primary_idle");
});
