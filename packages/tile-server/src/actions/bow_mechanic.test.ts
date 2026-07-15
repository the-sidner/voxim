/**
 * T-338 — the bow/crossbow path built on T-337's hold-to-aim mechanic,
 * exercised through REAL prefab content (wooden_bow/wooden_crossbow +
 * arrow/crossbow_bolt), not a synthetic fixture. Confirms the prefab
 * wiring itself (swingActionId) resolves correctly — this is exactly the
 * class of regression that shipped silently before (a bow with no
 * swingActionId defaulted to a melee blade-sweep action against a weapon
 * with no blade, tracing nothing).
 */

import { assertEquals } from "jsr:@std/assert";
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
import { StaminaCostHandler } from "./cost.ts";
import { ACTION_USE_SKILL } from "@voxim/protocol";

const content = await JsonSource.load();

Deno.test("T-338: wooden_bow.swingable.swingActionId resolves to an ambient hold-to-aim ActionDef", () => {
  const swingable = content.prefabs.get("wooden_bow")?.components["swingable"] as { swingActionId?: string } | undefined;
  const def = content.actions.get(swingable?.swingActionId ?? "");
  assertEquals(def?.kind, "ambient");
  assertEquals(def?.releaseActionId, "bow_loose");
});

Deno.test("T-338: wooden_crossbow.swingable.swingActionId resolves to an ambient hold-to-aim ActionDef", () => {
  const swingable = content.prefabs.get("wooden_crossbow")?.components["swingable"] as { swingActionId?: string } | undefined;
  const def = content.actions.get(swingable?.swingActionId ?? "");
  assertEquals(def?.kind, "ambient");
  assertEquals(def?.releaseActionId, "crossbow_loose");
});

function archer(world: World, weaponPrefabId: string, ammoPrefabId: string, ammo: number): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["primary"] });
  world.write(id, ActiveActions, { states: {} });
  world.write(id, Position, { x: 0, y: 0, z: 1 });
  world.write(id, Equipment, {
    weapon: { entityId: "w1", prefabId: weaponPrefabId },
    offHand: null, head: null, chest: null, legs: null, feet: null, back: null,
  });
  world.write(id, Inventory, {
    slots: ammo > 0 ? [{ kind: "stack", prefabId: ammoPrefabId, quantity: ammo }] : [],
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
  return new ActionDispatcher(content, gates, effects, new PrimaryIntentResolver(content), StaminaCostHandler);
}

function runTicks(world: World, d: ActionDispatcher, from: number, to: number): void {
  for (let t = from; t <= to; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
  }
}

Deno.test("T-338: a real wooden_bow draws, holds, and looses an arrow — real hit-path projectile, ammo consumed", () => {
  const world = new World();
  const id = archer(world, "wooden_bow", "arrow", 5);
  const d = dispatcher();

  setActions(world, id, ACTION_USE_SKILL);
  const drawTicks = content.actions.get("bow_draw")!.phases.windup.ticks;
  runTicks(world, d, 0, drawTicks);
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.actionId, "bow_draw");
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.phase, "hold");
  assertEquals(world.query(Velocity).length, 0, "still holding — nothing fired");

  setActions(world, id, 0); // release
  runTicks(world, d, drawTicks + 1, drawTicks + 1);
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.actionId, "bow_loose");
  assertEquals(world.query(Velocity).length, 1, "the arrow was fired");
  assertEquals(world.get(id, Inventory)?.slots[0], { kind: "stack", prefabId: "arrow", quantity: 4 });
});

Deno.test("T-338: a real wooden_crossbow with no bolts never starts the draw", () => {
  const world = new World();
  const id = archer(world, "wooden_crossbow", "crossbow_bolt", 0);
  const d = dispatcher();

  setActions(world, id, ACTION_USE_SKILL);
  runTicks(world, d, 0, 5);
  const cur = world.get(id, ActiveActions)?.states["primary"]?.actionId;
  assertEquals(cur !== "crossbow_draw", true, "no bolts — draw never started");
});
