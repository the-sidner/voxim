/**
 * use_item action integration (T-240 Ph1).
 *
 * Real content + dispatcher wiring: the generic `use_item` primary-slot
 * action gates on `slot_has_usable`, and on `apply:enter` fans the item's
 * synthesised `EffectSpec[]` through the shared registry — `adjust_resource`
 * drains Hunger/Thirst — then removes one from the inventory stack. Same
 * net behaviour as the retired `consume`, now one substrate.
 */

import { assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { Resource } from "../components/resource.ts";
import { Inventory } from "../components/items.ts";
import { ActionDispatcher } from "./dispatcher.ts";
import type { IntentResolver } from "./dispatcher.ts";
import { newGateRegistry } from "./gate.ts";
import { newEffectRegistry } from "./effect.ts";
import { slotHasUsableGate, ApplyItemEffectsResolver, adjustResourceResolver } from "./resolvers/item_use.ts";

const content = await JsonSource.load();

function wired(intent: IntentResolver): ActionDispatcher {
  const gates = newGateRegistry();
  gates.register(slotHasUsableGate);
  const effects = newEffectRegistry();
  effects.register(adjustResourceResolver);
  effects.register(new ApplyItemEffectsResolver(effects));
  return new ActionDispatcher(content, gates, effects, intent);
}

const wantUse: IntentResolver = { resolve: () => new Map([["primary", "use_item"]]) };

function eater(world: World, slots: Inventory_["slots"]): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["primary"] });
  world.write(id, ActiveActions, { states: {} });
  world.write(id, Inventory, { slots, capacity: 20 });
  world.write(id, Resource, {
    values: { hunger: { value: 50, max: 100 }, thirst: { value: 30, max: 100 } },
  });
  return id;
}
type Inventory_ = { slots: { kind: "stack"; prefabId: string; quantity: number }[] };

Deno.test("use_item: apply drains hunger/thirst and removes one berry", () => {
  const world = new World();
  const id = eater(world, [{ kind: "stack", prefabId: "berries", quantity: 3 }]);
  const d = wired(wantUse);

  // raise = 6 ticks, then apply:enter on tick 6 fires apply_item_effects.
  for (let t = 0; t <= 6; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
  }

  assertEquals(world.get(id, Resource)?.values.hunger.value, 42); // 50 − food 8
  assertEquals(world.get(id, Resource)?.values.thirst.value, 28); // 30 − water 2
  const slots = world.get(id, Inventory)!.slots;
  assertEquals(slots, [{ kind: "stack", prefabId: "berries", quantity: 2 }]);
});

Deno.test("use_item: slot_has_usable blocks the action with nothing usable", () => {
  const world = new World();
  const id = eater(world, [{ kind: "stack", prefabId: "wooden_sword", quantity: 1 }]);
  const d = wired(wantUse);

  for (let t = 0; t < 3; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
  }

  assertEquals(world.get(id, ActiveActions)?.states["primary"], undefined);
  assertEquals(world.get(id, Resource)?.values.hunger.value, 50);
});
