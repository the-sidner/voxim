/**
 * NPCs can pay stamina (T-255).
 *
 * Since the dispatcher charges action costs (T-229), a stamina-less actor
 * can never start a swing — which silently turned "NPC skills fizzle" into
 * "NPC melee never starts". Locks the fix: spawned NPCs carry a
 * template-driven stamina Resource, and a swing actually starts for an
 * actor with stamina while staying blocked for one without.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { ACTION_USE_SKILL } from "@voxim/protocol";
import { spawnPrefab } from "./spawner.ts";
import { Resource } from "./components/resource.ts";
import { ActorSlots, ActiveActions } from "./components/action.ts";
import { InputState } from "./components/game.ts";
import { ActionDispatcher } from "./actions/dispatcher.ts";
import { CompositeIntentResolver, PrimaryIntentResolver } from "./actions/intent.ts";
import { newGateRegistry } from "./actions/gate.ts";
import { newEffectRegistry } from "./actions/effect.ts";
import { StaminaCostHandler } from "./actions/cost.ts";

const content = await JsonSource.load();

Deno.test("T-255: a spawned wolf carries the template/default stamina pool", () => {
  const world = new World();
  const id = spawnPrefab(world, content, "wolf", { x: 0, y: 0, z: 0 });
  const stamina = world.get(id, Resource)?.values.stamina;
  assert(stamina, "NPC seeded with a stamina resource");
  const expected = content.npcTemplates.get("wolf")?.maxStamina
    ?? content.getGameConfig().npcAiDefaults.maxStamina;
  assertEquals(stamina.value, expected);
  assertEquals(stamina.max, expected);
});

Deno.test("T-255: with stamina a swing starts; without (the old NPC state) it never does", () => {
  const dispatcher = new ActionDispatcher(
    content, newGateRegistry(), newEffectRegistry(),
    new CompositeIntentResolver([new PrimaryIntentResolver(content)]),
    StaminaCostHandler,
  );

  const actor = (world: World, withStamina: boolean) => {
    const id = newEntityId();
    world.create(id);
    world.write(id, ActorSlots, { slots: ["primary"] });
    world.write(id, ActiveActions, { states: {} });
    // ACTION_USE_SKILL → unarmed swing_light (costs 10 stamina).
    world.write(id, InputState, {
      seq: 1, timestamp: 0, facing: 0, movementX: 0, movementY: 0,
      actions: ACTION_USE_SKILL, chargeMs: 0, rttMs: 0,
    });
    if (withStamina) {
      world.write(id, Resource, { values: { stamina: { value: 80, max: 80 } } });
    }
    return id;
  };

  const worldA = new World();
  const armed = actor(worldA, true);
  dispatcher.prepare(1);
  dispatcher.run(worldA, new EventBus(), 1 / 20);
  worldA.applyChangeset();
  assertEquals(worldA.get(armed, ActiveActions)!.states["primary"]?.actionId, "swing_light",
    "stamina-bearing actor starts the swing");

  const worldB = new World();
  const dry = actor(worldB, false);
  dispatcher.prepare(1);
  dispatcher.run(worldB, new EventBus(), 1 / 20);
  worldB.applyChangeset();
  const started = worldB.get(dry, ActiveActions)!.states["primary"]?.actionId;
  assert(started !== "swing_light", "stamina-less actor cannot start the swing (the T-255 bug shape)");
});
