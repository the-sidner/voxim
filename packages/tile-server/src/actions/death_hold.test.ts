/**
 * Death is a terminal held reaction (T-361 audit fix).
 *
 * A lingering corpse (T-311 P5c dissolve / T-339 crumble) keeps
 * `Health.current = 0` with its slots fully live for the whole dissolve /
 * crumble window. `ReactionIntentResolver` re-requests `death` every tick
 * off that stable condition — which is only safe because the death def now
 * ENDS in a perpetual `dead` phase: the slot never clears, so the
 * dispatcher's "already running it" check no-ops the re-request. Before
 * this, the 30-tick death action completed, the slot cleared, and the
 * corpse visibly "re-died" every 31 ticks for the whole linger (once per
 * dissolve, ~6 times per 200-tick crumble).
 *
 * Also pins the projection: the perpetual phase must not skew the play
 * phase's one-shot clip fit, and the held phase keeps the clip clamped at
 * its end (no snap back to the clip start, no reaction layer vanishing
 * into the locomotion idle pose).
 */

import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { Health } from "../components/game.ts";
import { ActionDispatcher } from "./dispatcher.ts";
import { ReactionIntentResolver } from "./intent.ts";
import { newGateRegistry } from "./gate.ts";
import { newEffectRegistry } from "./effect.ts";
import { projectLocomotion } from "../systems/animation.ts";

const content = await JsonSource.load();
const DT = 1 / 20;

Deno.test("a lingering corpse plays death once, then holds the perpetual `dead` phase — no replay loop", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["reaction"] });
  world.write(id, ActiveActions, { states: {} });
  world.write(id, Health, { current: 0, max: 100 });

  const d = new ActionDispatcher(
    content, newGateRegistry(), newEffectRegistry(), ReactionIntentResolver,
  );
  const tick = (t: number) => {
    d.prepare(t);
    d.run(world, new EventBus(), DT);
    world.applyChangeset();
  };

  tick(0);
  let s = world.get(id, ActiveActions)?.states["reaction"];
  assertEquals(s?.actionId, "death", "death starts off the stable hp<=0 condition");
  assertEquals(s?.phase, "play");

  // play is 30 ticks; the action then advances into `dead` instead of
  // completing (which would clear the slot and re-trigger the resolver).
  for (let t = 1; t <= 30; t++) tick(t);
  s = world.get(id, ActiveActions)?.states["reaction"];
  assertEquals(s?.actionId, "death");
  assertEquals(s?.phase, "dead", "death holds its terminal phase after play runs out");

  // Over a crumble-length linger (200 ticks) the slot never leaves `dead`
  // and the clip is never restarted — the pre-fix loop re-entered `play`
  // every 31 ticks.
  for (let t = 31; t <= 240; t++) {
    tick(t);
    const st = world.get(id, ActiveActions)?.states["reaction"];
    assertEquals(st?.actionId, "death", `slot still death at tick ${t}`);
    assertEquals(st?.phase, "dead", `still held at tick ${t}`);
  }
});

Deno.test("projection: the perpetual `dead` phase doesn't skew the play fit and holds the clip at its end", () => {
  const death = content.actions.get("death")!;
  const slotMap = { death: "clip_death" };

  // Play phase: the one-shot fit must span exactly the 30 finite ticks —
  // a naive sum over same-clip phases would add the perpetual phase's -1
  // and fit the clip across 29 ticks instead.
  const playLayer = projectLocomotion(
    content,
    { actionId: "death", phase: "play", ticksInPhase: 5, initiator: "event" },
    false, slotMap, new Map(), 0, 1,
  );
  assert(playLayer, "play phase projects a reaction layer");
  assertAlmostEquals(
    playLayer.speedScale as number,
    1 / (death.phases["play"].ticks * DT),
    1e-9,
    "one-shot fit spans the finite play ticks only",
  );

  // Held phase: the layer must still exist (an empty reaction slot would
  // let the locomotion idle pose show through mid-dissolve) and the clip
  // time stays clamped at the end.
  const holdLayer = projectLocomotion(
    content,
    { actionId: "death", phase: "dead", ticksInPhase: 40, initiator: "event" },
    false, slotMap, new Map([["clip_death", 1.0]]), 0, 1,
  );
  assert(holdLayer, "held `dead` phase still projects the death layer");
  assertEquals(holdLayer.clipId, "clip_death");
  assertEquals(holdLayer.time, 1.0, "clip clamped at its final frame");
});
