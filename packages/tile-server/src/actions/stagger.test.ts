/**
 * stagger reaction action owns its gameplay (T-232).
 *
 * stagger_heavy installs the `staggered` tag for its `play` phase — that
 * window IS the old networked Staggered countdown — and the
 * `not_staggered` precondition reads the tag, so a staggered actor can't
 * start a gated action until the reaction completes.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { Staggered } from "../components/tags.ts";
import { ActionDispatcher } from "./dispatcher.ts";
import type { IntentResolver } from "./dispatcher.ts";
import { newGateRegistry } from "./gate.ts";
import { newEffectRegistry } from "./effect.ts";
import { setTagResolver, clearTagResolver } from "./resolvers/tags.ts";
import { notStaggeredGate } from "./resolvers/gates.ts";

const content = await JsonSource.load();

function actor(world: World): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["reaction"] });
  world.write(id, ActiveActions, { states: {} });
  return id;
}

// Reaction slot wants stagger_heavy once, then nothing (event-posted in
// reality; a fixed first-tick desire models the PendingReaction consume).
function staggerOnce(): IntentResolver {
  let fired = false;
  return {
    resolve: () => {
      if (fired) return new Map([["reaction", null]]);
      fired = true;
      return new Map([["reaction", "stagger_heavy"]]);
    },
  };
}

Deno.test("stagger_heavy installs `staggered` for its play phase, clears on exit", () => {
  const world = new World();
  const id = actor(world);
  const gates = newGateRegistry();
  gates.register(notStaggeredGate);
  const effects = newEffectRegistry();
  effects.register(setTagResolver);
  effects.register(clearTagResolver);
  const d = new ActionDispatcher(content, gates, effects, staggerOnce());

  // Tick 0: reaction starts → play:enter set_tag staggered.
  d.prepare(0);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assert(world.has(id, Staggered), "staggered tag present at play start");
  assertEquals(
    notStaggeredGate.test({ world, entityId: id, content, params: {} }),
    false,
    "not_staggered fails while staggered",
  );

  // play is 14 ticks; tag persists, cleared on play:exit (tick 14).
  for (let t = 1; t < 14; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
    assert(world.has(id, Staggered), `staggered still present at tick ${t}`);
  }
  d.prepare(14);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assert(!world.has(id, Staggered), "staggered cleared after stagger completes");
  assertEquals(world.get(id, ActiveActions)?.states["reaction"], undefined);
  assertEquals(
    notStaggeredGate.test({ world, entityId: id, content, params: {} }),
    true,
    "not_staggered passes once recovered",
  );
});
