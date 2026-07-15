/**
 * uninterruptible_active gate (T-299).
 *
 * Two layers of coverage:
 *   1. Pure GateContext unit tests — the gate itself, no dispatcher.
 *   2. A real ActionDispatcher + real content (JsonSource.load) proving the
 *      reaction slot actually rejects/admits hit_front / stagger_heavy /
 *      death exactly as the gate intends while the actor's OWN primary slot
 *      runs a committed action's active phase.
 */
import { assertEquals } from "jsr:@std/assert";
import { World, newEntityId, EventBus } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { ActorSlots, ActiveActions } from "../../components/action.ts";
import { Health } from "../../components/game.ts";
import { ActionDispatcher } from "../dispatcher.ts";
import type { IntentResolver } from "../dispatcher.ts";
import { newGateRegistry } from "../gate.ts";
import { newEffectRegistry } from "../effect.ts";
import { setTagResolver, clearTagResolver } from "./tags.ts";
import { uninterruptibleActiveGate, notStaggeredGate } from "./gates.ts";
import type { GateContext } from "../gate.ts";

const content = await JsonSource.load();

// ---- 1. pure gate unit tests ----------------------------------------------

function ctxWithPrimary(world: World, entityId: EntityId): GateContext {
  return { world, entityId, content, params: {} };
}

Deno.test("uninterruptible_active: passes when the actor has no primary slot at all", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  assertEquals(uninterruptibleActiveGate.test(ctxWithPrimary(world, id)), true);
});

Deno.test("uninterruptible_active: passes while a committed action is in windup (not yet active)", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, ActiveActions, {
    states: { primary: { actionId: "swing_heavy", phase: "windup", ticksInPhase: 1, initiator: "intent" } },
  });
  assertEquals(uninterruptibleActiveGate.test(ctxWithPrimary(world, id)), true);
});

Deno.test("uninterruptible_active: fails while a committed action's active phase is running", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, ActiveActions, {
    states: { primary: { actionId: "swing_heavy", phase: "active", ticksInPhase: 0, initiator: "intent" } },
  });
  assertEquals(uninterruptibleActiveGate.test(ctxWithPrimary(world, id)), false);
});

Deno.test("uninterruptible_active: passes for a NON-committed primary action's active phase", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  // block is ambient/not committed — its "hold" phase must not trip the gate.
  world.write(id, ActiveActions, {
    states: { primary: { actionId: "block", phase: "hold", ticksInPhase: 3, initiator: "intent" } },
  });
  assertEquals(uninterruptibleActiveGate.test(ctxWithPrimary(world, id)), true);
});

// ---- 2. real dispatcher + real content ------------------------------------

function actorMidSwing(world: World, phase: string): EntityId {
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["primary", "reaction"] });
  world.write(id, ActiveActions, {
    states: { primary: { actionId: "swing_heavy", phase, ticksInPhase: 0, initiator: "intent" } },
  });
  return id;
}

function wantReaction(actionId: string): IntentResolver {
  return {
    resolve(_world, _entityId, slots) {
      const out = new Map<string, string | null>();
      if (slots.includes("reaction")) out.set("reaction", actionId);
      return out;
    },
  };
}

function dispatcherWithGates(intent: IntentResolver): ActionDispatcher {
  const gates = newGateRegistry();
  gates.register(uninterruptibleActiveGate);
  gates.register(notStaggeredGate);
  const effects = newEffectRegistry();
  effects.register(setTagResolver);
  effects.register(clearTagResolver);
  return new ActionDispatcher(content, gates, effects, intent);
}

function runOneTick(d: ActionDispatcher, world: World, tick = 1): void {
  d.prepare(tick);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
}

Deno.test("T-299: hit_front cannot start while the actor's own swing_heavy is mid-active", () => {
  const world = new World();
  const id = actorMidSwing(world, "active");
  const d = dispatcherWithGates(wantReaction("hit_front"));
  runOneTick(d, world);
  assertEquals(world.get(id, ActiveActions)!.states["reaction"], undefined,
    "the light reaction never starts — precondition rejects it");
});

Deno.test("T-299: hit_back cannot start while the actor's own swing_heavy is mid-active", () => {
  const world = new World();
  const id = actorMidSwing(world, "active");
  const d = dispatcherWithGates(wantReaction("hit_back"));
  runOneTick(d, world);
  assertEquals(world.get(id, ActiveActions)!.states["reaction"], undefined);
});

Deno.test("T-299: stagger_light cannot start while the actor's own swing_heavy is mid-active", () => {
  const world = new World();
  const id = actorMidSwing(world, "active");
  const d = dispatcherWithGates(wantReaction("stagger_light"));
  runOneTick(d, world);
  assertEquals(world.get(id, ActiveActions)!.states["reaction"], undefined);
});

Deno.test("T-299: stagger_heavy STILL starts while the actor's own swing_heavy is mid-active", () => {
  const world = new World();
  const id = actorMidSwing(world, "active");
  const d = dispatcherWithGates(wantReaction("stagger_heavy"));
  runOneTick(d, world);
  assertEquals(world.get(id, ActiveActions)!.states["reaction"]?.actionId, "stagger_heavy",
    "stagger_heavy has no uninterruptible_active precondition — it always cuts in");
});

Deno.test("T-299: death STILL starts while the actor's own swing_heavy is mid-active", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["primary", "reaction"] });
  world.write(id, ActiveActions, {
    states: { primary: { actionId: "swing_heavy", phase: "active", ticksInPhase: 0, initiator: "intent" } },
  });
  world.write(id, Health, { current: 0, max: 100 });
  // Death is derived from health<=0 by ReactionIntentResolver in real content,
  // but this test targets the gate registry directly — use a plain intent
  // resolver requesting "death" to isolate "does death's precondition set
  // (none) let it through", matching the other cases' shape.
  const d = dispatcherWithGates(wantReaction("death"));
  runOneTick(d, world);
  assertEquals(world.get(id, ActiveActions)!.states["reaction"]?.actionId, "death");
});

Deno.test("T-299: hit_front starts normally once the swing is no longer active (e.g. windup)", () => {
  const world = new World();
  const id = actorMidSwing(world, "windup");
  const d = dispatcherWithGates(wantReaction("hit_front"));
  runOneTick(d, world);
  assertEquals(world.get(id, ActiveActions)!.states["reaction"]?.actionId, "hit_front");
});

Deno.test("T-299: an actor with no primary slot at all still takes hit_front normally", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["reaction"] });
  world.write(id, ActiveActions, { states: {} });
  const d = dispatcherWithGates(wantReaction("hit_front"));
  runOneTick(d, world);
  assertEquals(world.get(id, ActiveActions)!.states["reaction"]?.actionId, "hit_front");
});
