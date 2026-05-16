/**
 * Time-step crafting as a Resource (T-238f).
 *
 * Real content (data/recipes/iron_smelt.json — stepType "time", 400
 * ticks). The `timeStep` handler owns only auto-start: it seeds a
 * `crafting_timer` Resource on the furnace. ResourceSystem counts it down
 * (rate -20/s → -1/tick) and its `cross@0` threshold fires the real
 * `resolve_recipe` effect exactly once — consuming inputs, spawning the
 * iron_ingot, emitting CraftingCompleted. Locks the couplings the retired
 * TimeStep "advance & resolve" loop owned.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import { Position } from "../components/game.ts";
import { ItemData } from "../components/items.ts";
import { WorkstationTag, WorkstationBuffer } from "../components/building.ts";
import { Resource } from "../components/resource.ts";
import { ResourceSystem } from "../systems/resource.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { newResourceEffectRegistry } from "../resources/effect.ts";
import { newResourceModifierRegistry } from "../resources/modifier.ts";
import { resolveRecipeEffect } from "../resources/effects/resolve_recipe.ts";
import { timeStep } from "./steps/time_step.ts";
import type { DeathRequestPort } from "../events/death.ts";

const DT = 1 / 20;
const noDeaths: DeathRequestPort = { request: () => {} };
const content = await JsonSource.load();

function sys(): ResourceSystem {
  const fx = newResourceEffectRegistry();
  fx.register(resolveRecipeEffect);
  return new ResourceSystem(content, fx, newResourceModifierRegistry(), noDeaths, newModifierSourceRegistry());
}

function furnace(world: World): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x: 10, y: 10, z: 4 });
  world.write(id, WorkstationTag, { stationType: "furnace", qualityTier: 1 });
  world.write(id, WorkstationBuffer, {
    capacity: 4,
    activeRecipeId: null,
    slots: [
      { kind: "stack", itemType: "iron_ore", quantity: 1 },
      { kind: "stack", itemType: "coal", quantity: 1 },
    ],
  });
  world.write(id, Resource, { values: {} });
  return id;
}

Deno.test("time recipe: auto-start seeds crafting_timer + binds the recipe", () => {
  const w = new World();
  const id = furnace(w);

  const tag = w.get(id, WorkstationTag)!;
  timeStep.onTick!({
    world: w, events: new EventBus(), content,
    stationId: id, stationType: tag.stationType, buffer: w.get(id, WorkstationBuffer)!,
  });
  w.applyChangeset();

  const timer = w.get(id, Resource)!.values.crafting_timer;
  assertEquals(timer, { value: 400, max: 400 }); // iron_smelt ticks
  assertEquals(w.get(id, WorkstationBuffer)!.activeRecipeId, "iron_smelt");
});

Deno.test("time recipe: counts down, resolves once at 0, spawns the ingot", () => {
  const s = sys();
  const w = new World();
  const id = furnace(w);

  let completions = 0;
  for (let i = 0; i < 460; i++) {
    const bus = new EventBus();
    bus.subscribe(TileEvents.CraftingCompleted, () => completions++);
    const tag = w.get(id, WorkstationTag)!;
    // CraftingSystem re-reads the buffer per tick before dispatching onTick.
    timeStep.onTick!({
      world: w, events: bus, content,
      stationId: id, stationType: tag.stationType, buffer: w.get(id, WorkstationBuffer)!,
    });
    s.run(w, bus, DT);
    w.applyChangeset();
  }

  // cross@0 fires exactly once — not every in-zone tick.
  assertEquals(completions, 1);
  // Inputs consumed, recipe binding cleared, timer parked at 0.
  const buf = w.get(id, WorkstationBuffer)!;
  assertEquals(buf.slots.filter((sl) => sl !== null).length, 0);
  assertEquals(buf.activeRecipeId, null);
  assertEquals(w.get(id, Resource)!.values.crafting_timer.value, 0);
  // The iron_ingot output entity exists (stat-bearing → unique entity).
  const ingots = w.query(ItemData).filter((e) => e.itemData.prefabId === "iron_ingot");
  assert(ingots.length >= 1, "iron_ingot spawned");
});
