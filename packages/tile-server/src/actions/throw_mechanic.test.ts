/**
 * End-to-end proof of T-337's own required deliverable: "the same mechanic
 * must drive a thrown item ... prove it with content." Real content (sling
 * + throwing_rock + throw_draw/throw_release), real ActionDispatcher +
 * PrimaryIntentResolver, real has_item/consume_item/projectile_spawn
 * resolvers — hold to draw, release to throw, ammo consumed, a projectile
 * entity spawns. Block cancels a draw cleanly (no throw, no ammo spent).
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { Position, Velocity, InputState } from "../components/game.ts";
import { Equipment } from "../components/equipment.ts";
import { Inventory } from "../components/items.ts";
import { Resource } from "../components/resource.ts";
import { ActionDispatcher } from "./dispatcher.ts";
import { newGateRegistry } from "./gate.ts";
import { newEffectRegistry } from "./effect.ts";
import { PrimaryIntentResolver } from "./intent.ts";
import { hasItemGate, consumeItemResolver } from "./resolvers/inventory_item.ts";
import { ProjectileSpawnResolver } from "./resolvers/combat.ts";
import { setTagResolver, clearTagResolver } from "./resolvers/tags.ts";
import { StaminaCostHandler } from "./cost.ts";
import { ACTION_BLOCK, ACTION_USE_SKILL } from "@voxim/protocol";

const content = await JsonSource.load();

function thrower(world: World, ammo: number): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["primary"] });
  world.write(id, ActiveActions, { states: {} });
  world.write(id, Position, { x: 0, y: 0, z: 1 });
  world.write(id, Equipment, {
    weapon: { entityId: "sling1", prefabId: "sling" },
    offHand: null, head: null, chest: null, legs: null, feet: null, back: null,
  });
  world.write(id, Inventory, {
    slots: ammo > 0 ? [{ kind: "stack", prefabId: "throwing_rock", quantity: ammo }] : [],
    capacity: 20,
  });
  world.write(id, Resource, { values: { stamina: { value: 100, max: 100 } } });
  return id;
}

function setActions(world: World, id: string, actions: number): void {
  world.write(id, InputState, {
    facing: 0, pitch: 0, movementX: 0, movementY: 0, actions, chargeMs: 0,
    seq: 0, timestamp: 0, rttMs: 0,
  });
}

function dispatcher(): ActionDispatcher {
  const gates = newGateRegistry();
  gates.register(hasItemGate);
  const effects = newEffectRegistry();
  effects.register(consumeItemResolver);
  effects.register(new ProjectileSpawnResolver());
  // block (real content) needs these — pulled in only by the block-cancel test.
  effects.register(setTagResolver);
  effects.register(clearTagResolver);
  return new ActionDispatcher(content, gates, effects, new PrimaryIntentResolver(content), StaminaCostHandler);
}

function runTicks(world: World, d: ActionDispatcher, from: number, to: number): void {
  for (let t = from; t <= to; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
  }
}

function projectileCount(world: World): number {
  // Every entity with a Velocity written by projectile_spawn also carries
  // Position; the thrower itself has Position but no Velocity, so this is
  // an unambiguous count for this fixture.
  return world.query(Velocity).length;
}

Deno.test("T-337: hold-to-throw — draw, hold, release spawns a projectile and consumes one rock", () => {
  const world = new World();
  const id = thrower(world, 3);
  const d = dispatcher();

  setActions(world, id, ACTION_USE_SKILL);
  const drawTicks = content.actions.get("throw_draw")!.phases.windup.ticks;
  runTicks(world, d, 0, drawTicks); // through the windup into the perpetual hold
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.actionId, "throw_draw");
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.phase, "hold");
  assertEquals(projectileCount(world), 0, "nothing fired yet — still holding");

  // Release.
  setActions(world, id, 0);
  runTicks(world, d, drawTicks + 1, drawTicks + 1);
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.actionId, "throw_release");
  assertEquals(projectileCount(world), 1, "the release fired projectile_spawn");
  assertEquals(world.get(id, Inventory)?.slots[0], { kind: "stack", prefabId: "throwing_rock", quantity: 2 }, "one rock consumed");
});

Deno.test("T-337: block cancels a throw draw — no projectile, no ammo spent", () => {
  const world = new World();
  const id = thrower(world, 3);
  const d = dispatcher();

  setActions(world, id, ACTION_USE_SKILL);
  runTicks(world, d, 0, 2); // mid-windup

  // Block interrupts unconditionally.
  setActions(world, id, ACTION_BLOCK);
  runTicks(world, d, 3, 3);
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.actionId, "block");
  assertEquals(projectileCount(world), 0, "no throw fired");
  assertEquals(world.get(id, Inventory)?.slots[0], { kind: "stack", prefabId: "throwing_rock", quantity: 3 }, "no ammo spent");
});

Deno.test("T-337: no ammo — the draw never starts (has_item precondition blocks canStart)", () => {
  const world = new World();
  const id = thrower(world, 0);
  const d = dispatcher();

  setActions(world, id, ACTION_USE_SKILL);
  runTicks(world, d, 0, 5);
  assert(
    world.get(id, ActiveActions)?.states["primary"]?.actionId !== "throw_draw",
    "throw_draw never started without ammo",
  );
});
