/**
 * request_action BT node + RequestedActions channel (T-234).
 *
 * Proves a behavior tree can name an arbitrary action and have the
 * dispatcher run it on an NPC slot — the data-driven path that doesn't go
 * through the InputState action bits — and that it overrides the
 * bit-derived intent (composed last).
 */

import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { createBTNodeRegistry, registerBuiltinBTNodes, buildBehaviorTree } from "./mod.ts";
import type { BTOutput } from "./mod.ts";
import { ActorSlots, ActiveActions, RequestedActions } from "../../components/action.ts";
import {
  CompositeIntentResolver,
  PrimaryIntentResolver,
  RequestedActionIntentResolver,
} from "../../actions/intent.ts";
import { ActionDispatcher } from "../../actions/dispatcher.ts";
import { newGateRegistry } from "../../actions/gate.ts";
import { newEffectRegistry } from "../../actions/effect.ts";
import { setTagResolver, clearTagResolver } from "../../actions/resolvers/tags.ts";

const content = await JsonSource.load();

const registry = createBTNodeRegistry();
registerBuiltinBTNodes(registry);

Deno.test("request_action node writes the slot→action into BTOutput", () => {
  const bt = buildBehaviorTree(
    { type: "request_action", slot: "primary", action: "block" },
    registry,
  );
  const out: BTOutput = {};
  // BTContext is unused by this node; a bare cast is fine for the unit.
  assertEquals(bt.tick({} as never, out), "success");
  assertEquals(out.requestedActions, { primary: "block" });
});

Deno.test("request_action validates its spec at build time", () => {
  assertThrows(() => buildBehaviorTree({ type: "request_action", slot: "primary" }, registry), Error, "action");
  assertThrows(() => buildBehaviorTree({ type: "request_action", action: "block" }, registry), Error, "slot");
});

Deno.test("RequestedActions drives the dispatcher and overrides bit intent", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["primary"] });
  world.write(id, ActiveActions, { states: {} });
  // A BT requested `block` on primary (what NpcAiSystem mirrors each tick).
  world.write(id, RequestedActions, { requests: { primary: "block" } });

  const effects = newEffectRegistry();
  effects.register(setTagResolver);
  effects.register(clearTagResolver);
  // Composite mirrors server.ts order: PrimaryIntentResolver would pick
  // primary_idle (no input bits), but RequestedActionIntentResolver is last
  // and wins.
  const d = new ActionDispatcher(
    content,
    newGateRegistry(),
    effects,
    new CompositeIntentResolver([
      new PrimaryIntentResolver(content),
      RequestedActionIntentResolver,
    ]),
  );

  d.prepare(0);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();

  assertEquals(
    world.get(id, ActiveActions)?.states["primary"]?.actionId,
    "block",
    "the BT-named action ran on the slot, not primary_idle",
  );
});
