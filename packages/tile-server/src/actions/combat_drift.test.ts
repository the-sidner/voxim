/**
 * Combat drift sweep (T-254).
 *
 * - A running reaction's incumbent weight is its interruptPriority: a tap's
 *   hit_front (10) no longer cancels a hard stagger_heavy (60); death (100)
 *   still preempts everything.
 * - Content invariant: every action wiring weapon_trace on active:enter
 *   also wires active:tick — multi-tick active windows trace their whole
 *   arc (swing_heavy's 3 active ticks contributed nothing before).
 * - DoT lethality regression: a lethal DoT tick drives health to 0 and
 *   DeathSystem's sweep (T-249) kills — a poisoned target no longer sits
 *   at 0 HP forever.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { Registry, World, EventBus, newEntityId } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import type { ContentService } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { Health } from "../components/game.ts";
import { ActionDispatcher } from "./dispatcher.ts";
import type { IntentResolver } from "./dispatcher.ts";
import { newGateRegistry } from "./gate.ts";
import { newEffectRegistry } from "./effect.ts";
import { setTagResolver, clearTagResolver } from "./resolvers/tags.ts";
import { spawnBuffChild, buffTickResolver } from "./resolvers/buff.ts";
import type { ActiveActionState } from "../components/action.ts";
import type { ResolveContext } from "./effect.ts";
import { DeathSystem } from "../systems/death.ts";
import type { DeathHook } from "../systems/death.ts";

const content = await JsonSource.load();

function reactingActor(world: World, runningId: string): EntityId {
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["reaction"] });
  world.write(id, ActiveActions, {
    states: { reaction: { actionId: runningId, phase: "play", ticksInPhase: 1, initiator: "event" } },
  });
  return id;
}

function wantOnReaction(actionId: string | null): IntentResolver {
  return { resolve: () => new Map([["reaction", actionId]]) };
}

function dispatcherWith(intent: IntentResolver): ActionDispatcher {
  const effects = newEffectRegistry();
  effects.register(setTagResolver);
  effects.register(clearTagResolver);
  return new ActionDispatcher(content, newGateRegistry(), effects, intent);
}

Deno.test("T-254: hit_front (10) cannot cancel a running stagger_heavy (60)", () => {
  const world = new World();
  const id = reactingActor(world, "stagger_heavy");
  const d = dispatcherWith(wantOnReaction("hit_front"));
  d.prepare(1);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(world.get(id, ActiveActions)!.states["reaction"]?.actionId, "stagger_heavy",
    "the hard stagger keeps its lockout");
});

Deno.test("T-254: death (100) still preempts a running stagger_heavy", () => {
  const world = new World();
  const id = reactingActor(world, "stagger_heavy");
  const d = dispatcherWith(wantOnReaction("death"));
  d.prepare(1);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(world.get(id, ActiveActions)!.states["reaction"]?.actionId, "death");
});

Deno.test("T-254: every weapon_trace on active:enter is paired with active:tick", () => {
  for (const action of content.actions.values()) {
    const traces = action.effects.filter((e) => e.kind === "weapon_trace");
    if (traces.length === 0) continue;
    const phases = traces.map((e) => e.phase);
    assert(phases.includes("active:enter") && phases.includes("active:tick"),
      `action "${action.id}" must trace on enter AND tick (got ${phases.join(", ")})`);
  }
});

Deno.test("T-254: a lethal DoT kills via DeathSystem's health≤0 sweep", () => {
  const world = new World();
  const events = new EventBus();
  const victim = newEntityId();
  world.create(victim);
  world.write(victim, Health, { current: 3, max: 100 });

  // A poison buff child ticking -5: the buff_tick clamps health at 0 …
  const buff = spawnBuffChild(world, victim, { stat: "health", op: "add", value: 0, tickDelta: -5 }, 100);
  const ctx: ResolveContext = {
    world, events, entityId: buff, slot: "buff",
    state: { actionId: "buff", phase: "hold", ticksInPhase: 1, initiator: "ambient" } as ActiveActionState,
    content: {} as ContentService, params: {}, edge: "tick", serverTick: 1,
  };
  buffTickResolver.resolve(ctx);
  world.applyChangeset();
  assertEquals(world.get(victim, Health)!.current, 0, "DoT floors health at 0");

  // … and the sweep turns 0 into a death (the old bug: it sat there forever).
  const died: EntityId[] = [];
  events.subscribe(TileEvents.EntityDied, (p: { entityId: EntityId }) => died.push(p.entityId));
  const deaths = new DeathSystem(new Registry<DeathHook>());
  deaths.run(world, events, 1 / 20);
  world.applyChangeset();
  assertEquals(died, [victim], "DoT kill goes through the one lethality path");
  assert(!world.isAlive(victim));
});
