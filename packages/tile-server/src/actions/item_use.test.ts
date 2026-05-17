/**
 * use_item action integration (T-240).
 *
 * Real content + dispatcher wiring: the generic `use_item` primary-slot
 * action gates on `slot_has_usable`, and on `apply:enter` fans the item's
 * `EffectSpec[]` through the shared registry — `adjust_resource` drains
 * Hunger/Thirst — then removes one from the inventory. Ph2: the payload is
 * read straight off the data (prefab `effects` for stackables, the
 * `ItemEffects` instance component for uniques) — no `deriveItemStats`
 * bridge, no `edible` component.
 */

import { assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { Resource } from "../components/resource.ts";
import { Inventory, ItemData } from "../components/items.ts";
import { ItemEffects } from "../components/instance.ts";
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

type Slots = Inventory_["slots"];
type Inventory_ = { slots: ({ kind: "stack"; prefabId: string; quantity: number } | { kind: "unique"; entityId: string })[] };

function eater(world: World, slots: Slots): string {
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

function run(d: ActionDispatcher, world: World, ticks: number): void {
  for (let t = 0; t <= ticks; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
  }
}

Deno.test("use_item: stackable berries — effects come off the prefab", () => {
  const world = new World();
  const id = eater(world, [{ kind: "stack", prefabId: "berries", quantity: 3 }]);
  // raise = 6 ticks, then apply:enter on tick 6 fires apply_item_effects.
  run(wired(wantUse), world, 6);

  assertEquals(world.get(id, Resource)?.values.hunger.value, 42); // 50 − food 8
  assertEquals(world.get(id, Resource)?.values.thirst.value, 28); // 30 − water 2
  assertEquals(world.get(id, Inventory)!.slots, [{ kind: "stack", prefabId: "berries", quantity: 2 }]);
});

Deno.test("use_item: unique item — effects come off the ItemEffects instance", () => {
  const world = new World();
  const itemId = newEntityId();
  world.create(itemId);
  world.write(itemId, ItemData, { prefabId: "_potion", quantity: 1 });
  world.write(itemId, ItemEffects, {
    effects: [{ id: "adjust_resource", params: { deltas: { hunger: -20 } } }],
  });
  const id = eater(world, [{ kind: "unique", entityId: itemId }]);
  run(wired(wantUse), world, 6);

  assertEquals(world.get(id, Resource)?.values.hunger.value, 30); // 50 − 20
  assertEquals(world.get(id, Inventory)!.slots, []);              // unique destroyed
  assertEquals(world.isAlive(itemId), false);
});

Deno.test("use_item: slot_has_usable blocks the action with nothing usable", () => {
  const world = new World();
  const id = eater(world, [{ kind: "stack", prefabId: "wooden_sword", quantity: 1 }]);
  run(wired(wantUse), world, 3);

  assertEquals(world.get(id, ActiveActions)?.states["primary"], undefined);
  assertEquals(world.get(id, Resource)?.values.hunger.value, 50);
});
