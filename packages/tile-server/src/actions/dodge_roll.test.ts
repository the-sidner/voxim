/**
 * dodge_roll integration (T-229).
 *
 * Real content + real dispatcher wiring (gates + effects + StaminaCostHandler)
 * exercising the dodge action end-to-end: the dash phase commits an impulse
 * Velocity, installs the `iframe` tag for its duration and clears it on
 * exit, spends stamina, and is gated by not_exhausted.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { ACTION_DODGE } from "@voxim/protocol";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { InputState, Velocity, Facing } from "../components/game.ts";
import { Resource } from "../components/resource.ts";
import { IFrame } from "../components/tags.ts";
import { ActionDispatcher } from "./dispatcher.ts";
import type { IntentResolver } from "./dispatcher.ts";
import { newGateRegistry } from "./gate.ts";
import { newEffectRegistry } from "./effect.ts";
import { setTagResolver, clearTagResolver } from "./resolvers/tags.ts";
import { dodgeImpulseResolver } from "./resolvers/movement.ts";
import { notStaggeredGate, notExhaustedGate } from "./resolvers/gates.ts";
import { StaminaCostHandler } from "./cost.ts";

const content = await JsonSource.load();

function wiredDispatcher(intent: IntentResolver): ActionDispatcher {
  const gates = newGateRegistry();
  gates.register(notStaggeredGate);
  gates.register(notExhaustedGate);
  const effects = newEffectRegistry();
  effects.register(setTagResolver);
  effects.register(clearTagResolver);
  effects.register(dodgeImpulseResolver);
  return new ActionDispatcher(content, gates, effects, intent, StaminaCostHandler);
}

const wantDodge: IntentResolver = { resolve: () => new Map([["locomotion", "dodge_roll"]]) };

function dodger(world: World): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["locomotion"] });
  world.write(id, ActiveActions, { states: {} });
  world.write(id, InputState, {
    seq: 0, timestamp: 0, facing: 0, movementX: 1, movementY: 0,
    actions: ACTION_DODGE, chargeMs: 0, rttMs: 0,
  });
  world.write(id, Facing, { angle: 0 });
  world.write(id, Velocity, { x: 0, y: 0, z: 0 });
  world.write(id, Resource, { values: { stamina: { value: 100, max: 100 } } });
  return id;
}

Deno.test("dodge_roll: dash commits impulse + iframe + spends stamina", () => {
  const world = new World();
  const id = dodger(world);
  const d = wiredDispatcher(wantDodge);

  // Tick 0: intent starts dodge_roll → dash:enter fires dodge_impulse +
  // set_tag iframe, StaminaCostHandler deducts the 15 cost.
  d.prepare(0);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();

  const dodgeSpeed = content.getGameConfig().dodge.speed;
  assertEquals(world.get(id, Velocity), { x: dodgeSpeed, y: 0, z: 0 });
  assert(world.has(id, IFrame), "iframe tag present during dash");
  assertEquals(world.get(id, Resource)?.values.stamina.value, 85); // 100 − 15
  assertEquals(world.get(id, ActiveActions)?.states["locomotion"]?.phase, "dash");

  // iframe stays installed for every tick of the 5-tick dash phase.
  for (let t = 1; t < 5; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
    assert(world.has(id, IFrame), `iframe still present at tick ${t}`);
  }

  // dash:exit clears iframe; with intent still desiring dodge_roll the
  // dispatcher restarts it the same tick (a fresh dash, stamina spent
  // again) — the cancel-committed dash never lingers past its 5 ticks.
  d.prepare(5);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(world.get(id, Resource)?.values.stamina.value, 70); // restarted: −15 again
  assertEquals(world.get(id, ActiveActions)?.states["locomotion"]?.ticksInPhase, 0);
});

Deno.test("dodge_roll: not_exhausted precondition blocks an exhausted actor", () => {
  const world = new World();
  const id = dodger(world);
  world.write(id, Resource, { values: { stamina: { value: 0, max: 100 } } });
  const d = wiredDispatcher(wantDodge);

  d.prepare(0);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();

  assertEquals(world.get(id, ActiveActions)?.states["locomotion"], undefined);
  assert(!world.has(id, IFrame), "no i-frames when the dodge never starts");
});
