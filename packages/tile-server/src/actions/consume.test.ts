/**
 * consume action integration (T-230).
 *
 * Real content + dispatcher wiring: the `consume` primary-slot action
 * gates on `has_edible`, and on `ingest:enter` drains Hunger/Thirst and
 * removes one from the inventory stack — exactly the retired
 * ConsumptionSystem's behaviour, now animation-paced.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { Hunger, Thirst } from "../components/game.ts";
import { Inventory } from "../components/items.ts";
import { ActionDispatcher } from "./dispatcher.ts";
import type { IntentResolver } from "./dispatcher.ts";
import { newGateRegistry } from "./gate.ts";
import { newEffectRegistry } from "./effect.ts";
import { consumeItemResolver, hasEdibleGate } from "./resolvers/consume.ts";

const content = await JsonSource.load();

function wired(intent: IntentResolver): ActionDispatcher {
  const gates = newGateRegistry();
  gates.register(hasEdibleGate);
  const effects = newEffectRegistry();
  effects.register(consumeItemResolver);
  return new ActionDispatcher(content, gates, effects, intent);
}

const wantConsume: IntentResolver = { resolve: () => new Map([["primary", "consume"]]) };

function eater(world: World, slots: Inventory_["slots"]): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["primary"] });
  world.write(id, ActiveActions, { states: {} });
  world.write(id, Inventory, { slots, capacity: 20 });
  world.write(id, Hunger, { value: 50 });
  world.write(id, Thirst, { value: 30 });
  return id;
}
type Inventory_ = { slots: { kind: "stack"; prefabId: string; quantity: number }[] };

Deno.test("consume: ingest drains hunger/thirst and removes one berry", () => {
  const world = new World();
  const id = eater(world, [{ kind: "stack", prefabId: "berries", quantity: 3 }]);
  const d = wired(wantConsume);

  // raise = 6 ticks, then ingest:enter on tick 6 fires consume_item.
  for (let t = 0; t <= 6; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
  }

  assertEquals(world.get(id, Hunger)?.value, 42); // 50 − food 8
  assertEquals(world.get(id, Thirst)?.value, 28); // 30 − water 2
  const slots = world.get(id, Inventory)!.slots;
  assertEquals(slots, [{ kind: "stack", prefabId: "berries", quantity: 2 }]);
});

Deno.test("consume: has_edible blocks the action with no food in inventory", () => {
  const world = new World();
  const id = eater(world, [{ kind: "stack", prefabId: "wooden_sword", quantity: 1 }]);
  const d = wired(wantConsume);

  for (let t = 0; t < 3; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
  }

  assertEquals(world.get(id, ActiveActions)?.states["primary"], undefined);
  assertEquals(world.get(id, Hunger)?.value, 50);
});
