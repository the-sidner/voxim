/**
 * has_item gate + consume_item effect (T-337).
 *
 * Direct unit tests (no dispatcher needed — both handlers only touch
 * Inventory). Covers stack slots, unique slots, the raced-away no-op,
 * and the NPC exemption (no Inventory component at all).
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import { Inventory, ItemData } from "../../components/items.ts";
import type { ActiveActionState } from "../../components/action.ts";
import type { GateContext } from "../gate.ts";
import type { ResolveContext } from "../effect.ts";
import { hasItemGate, consumeItemResolver } from "./inventory_item.ts";

const STATE: ActiveActionState = { actionId: "", phase: "", ticksInPhase: 0, initiator: "intent" };

function gateCtx(world: World, entityId: EntityId, prefabId: string): GateContext {
  return { world, entityId, content: {} as ContentService, params: { prefabId } };
}

function effectCtx(world: World, entityId: EntityId, prefabId: string): ResolveContext {
  return {
    world, events: new EventBus(), entityId, slot: "primary", state: STATE,
    content: {} as ContentService, params: { prefabId }, edge: "enter", serverTick: 0,
  };
}

Deno.test("has_item: passes when a matching stack is present, fails when absent", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, Inventory, { slots: [{ kind: "stack", prefabId: "arrow", quantity: 3 }], capacity: 20 });

  assert(hasItemGate.test(gateCtx(world, id, "arrow")));
  assert(!hasItemGate.test(gateCtx(world, id, "bolt")));
});

Deno.test("has_item: passes for a matching unique item entity", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  const item = newEntityId();
  world.create(item);
  world.write(item, ItemData, { prefabId: "iron_sword", quantity: 1 });
  world.write(id, Inventory, { slots: [{ kind: "unique", entityId: item }], capacity: 20 });

  assert(hasItemGate.test(gateCtx(world, id, "iron_sword")));
});

Deno.test("has_item: vacuously true when the entity carries no Inventory at all (NPCs)", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  // No Inventory written — mirrors installNpc, which never writes one.
  assert(hasItemGate.test(gateCtx(world, id, "arrow")), "ammo economy doesn't apply to entities with no inventory system");
});

Deno.test("has_item: false with an empty inventory", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, Inventory, { slots: [], capacity: 20 });
  assert(!hasItemGate.test(gateCtx(world, id, "arrow")));
});

Deno.test("consume_item: decrements a stack of quantity > 1", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, Inventory, { slots: [{ kind: "stack", prefabId: "arrow", quantity: 3 }], capacity: 20 });

  consumeItemResolver.resolve(effectCtx(world, id, "arrow"));
  world.applyChangeset();

  const slots = world.get(id, Inventory)!.slots;
  assertEquals(slots.length, 1);
  assertEquals(slots[0], { kind: "stack", prefabId: "arrow", quantity: 2 });
});

Deno.test("consume_item: a stack of quantity 1 is removed entirely", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, Inventory, { slots: [{ kind: "stack", prefabId: "arrow", quantity: 1 }], capacity: 20 });

  consumeItemResolver.resolve(effectCtx(world, id, "arrow"));
  world.applyChangeset();

  assertEquals(world.get(id, Inventory)!.slots.length, 0);
});

Deno.test("consume_item: a unique item entity is destroyed and its slot removed", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  const item = newEntityId();
  world.create(item);
  world.write(item, ItemData, { prefabId: "iron_sword", quantity: 1 });
  world.write(id, Inventory, { slots: [{ kind: "unique", entityId: item }], capacity: 20 });

  consumeItemResolver.resolve(effectCtx(world, id, "iron_sword"));
  world.applyChangeset();

  assertEquals(world.get(id, Inventory)!.slots.length, 0);
  assert(!world.isAlive(item), "the unique item entity is destroyed");
});

Deno.test("consume_item: no-ops when the item isn't present (raced away)", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, Inventory, { slots: [{ kind: "stack", prefabId: "bolt", quantity: 1 }], capacity: 20 });

  consumeItemResolver.resolve(effectCtx(world, id, "arrow"));
  world.applyChangeset();

  assertEquals(world.get(id, Inventory)!.slots.length, 1, "unrelated slot untouched");
});

Deno.test("consume_item: no-ops for an entity with no Inventory (same exemption as the gate)", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  // Must not throw.
  consumeItemResolver.resolve(effectCtx(world, id, "arrow"));
  world.applyChangeset();
  assertEquals(world.has(id, Inventory), false);
});
