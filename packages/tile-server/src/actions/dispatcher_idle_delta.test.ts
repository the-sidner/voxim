/**
 * ActionDispatcher × sparse delta channel (T-363).
 *
 * A slot's perpetual (`ticks: -1`) phase — idle's ambient `hold`, a
 * lingering corpse's terminal `dead` — advances `ticksInPhase` every tick
 * the dispatcher runs, so `sameStates()` (comparing the full slot state,
 * ticksInPhase included) called `world.set(ActiveActions, ...)` forever:
 * every entry in the applied changeset becomes a wire delta (T-361's
 * `physics_idle_delta.test.ts` pins the same mechanism for Position/
 * Velocity/Facing), so an idle actor — or a corpse sitting in `dead` for
 * the rest of the encounter — re-shipped the whole ActiveActions struct
 * every tick, 20 times a second, forever. `sameStates` still gates the
 * `world.set` CALL (it must — a held block/bow-draw's committed
 * ticksInPhase has to stay live for the parry-window / charge-duration
 * gates that read it via `world.get`), but the `ActiveActions` component's
 * `wireEquals` (T-363) now separately decides the wire ship, ignoring
 * ticksInPhase — so the commit still lands every tick, only the outbound
 * delta is suppressed.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { EventBus, World, newEntityId } from "@voxim/engine";
import { StaticContentStore } from "@voxim/content";
import type { ActionDef } from "@voxim/content";
import type { ChangesetSet } from "@voxim/engine";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { ActionDispatcher } from "./dispatcher.ts";
import { newGateRegistry } from "./gate.ts";
import { newEffectRegistry } from "./effect.ts";

function content(...defs: ActionDef[]): StaticContentStore {
  const s = new StaticContentStore();
  for (const d of defs) s.registerAction(d);
  return s;
}

/** Networked ActiveActions sets for one entity in an applied changeset. */
function activeActionsSets(sets: ReadonlyArray<ChangesetSet>, entityId: string): ChangesetSet[] {
  return sets.filter((s) => s.entityId === entityId && s.token === ActiveActions);
}

const idle: ActionDef = {
  id: "idle", kind: "ambient", slot: "locomotion",
  phases: { hold: { ticks: -1 } },
  cancel: { hold: { into: ["any"] } },
  movement: { hold: "free" },
  effects: [],
};

const walk: ActionDef = {
  id: "walk", kind: "ambient", slot: "locomotion",
  phases: { hold: { ticks: -1 } },
  cancel: { hold: { into: ["any"] } },
  movement: { hold: "free" },
  effects: [],
};

// A minimal death-shaped reaction: a finite `play` phase, then a perpetual
// terminal `dead` phase — same shape as the real content/data/actions/death.json.
const death: ActionDef = {
  id: "death", kind: "reaction", slot: "reaction", interruptPriority: 100,
  phases: { play: { ticks: 3 }, dead: { ticks: -1 } },
  cancel: { play: { into: [] }, dead: { into: [] } },
  movement: { play: "locked", dead: "locked" },
  effects: [],
};

Deno.test("ActionDispatcher: an idle actor's ambient locomotion slot stops re-shipping ActiveActions", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["locomotion"] });
  world.write(id, ActiveActions, {
    states: { locomotion: { actionId: "idle", phase: "hold", ticksInPhase: 0, initiator: "ambient" } },
  });

  const d = new ActionDispatcher(content(idle, walk), newGateRegistry(), newEffectRegistry());

  for (let t = 1; t <= 20; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    const changeset = world.applyChangeset();
    assertEquals(
      activeActionsSets(changeset.sets, id).length,
      0,
      `tick ${t}: idle actor must not re-ship ActiveActions for ticksInPhase alone`,
    );
  }

  // The commit underneath is still live — ticksInPhase kept advancing for
  // internal readers (parry window, bow-charge, dodge-debounce gates) even
  // though nothing shipped.
  assertEquals(world.get(id, ActiveActions)?.states["locomotion"]?.ticksInPhase, 20);
});

Deno.test("ActionDispatcher: a real slot change (locomotion swap) still ships exactly one delta", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["locomotion"] });
  world.write(id, ActiveActions, {
    states: { locomotion: { actionId: "idle", phase: "hold", ticksInPhase: 0, initiator: "ambient" } },
  });

  const d = new ActionDispatcher(
    content(idle, walk),
    newGateRegistry(),
    newEffectRegistry(),
    { resolve: () => new Map([["locomotion", "walk"]]) },
  );

  // Tick 1: intent swaps idle → walk.
  d.prepare(1);
  d.run(world, new EventBus(), 1 / 20);
  const changeset = world.applyChangeset();
  const sets = activeActionsSets(changeset.sets, id);
  assertEquals(sets.length, 1, "a real actionId change must ship exactly one delta");
  const data = sets[0].data as { states: Record<string, { actionId: string }> };
  assertEquals(data.states["locomotion"]?.actionId, "walk");

  // Steady in the new state — silent again.
  for (let t = 2; t <= 10; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    const cs = world.applyChangeset();
    assertEquals(activeActionsSets(cs.sets, id).length, 0, `tick ${t}: steady in walk must stay silent`);
  }
});

Deno.test("ActionDispatcher: a lingering corpse in death's terminal `dead` phase stops re-shipping ActiveActions", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["reaction"] });
  world.write(id, ActiveActions, {
    states: { reaction: { actionId: "death", phase: "play", ticksInPhase: 0, initiator: "event" } },
  });

  const d = new ActionDispatcher(content(death), newGateRegistry(), newEffectRegistry());
  const tick = (t: number) => {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    return world.applyChangeset();
  };

  // play is 3 ticks; the phase-exit transition into `dead` on tick 3 is a
  // real, wire-worthy change (actionId same, phase differs).
  let sawDeadTransition = false;
  for (let t = 1; t <= 3; t++) {
    const cs = tick(t);
    const sets = activeActionsSets(cs.sets, id);
    if (world.get(id, ActiveActions)?.states["reaction"]?.phase === "dead" && sets.length === 1) {
      sawDeadTransition = true;
    }
  }
  assert(sawDeadTransition, "the play→dead transition must ship exactly one delta on the tick it happens");
  assertEquals(world.get(id, ActiveActions)?.states["reaction"]?.phase, "dead");

  // Lingering corpse: 100 more ticks held in the perpetual `dead` phase —
  // zero further ActiveActions deltas, even though ticksInPhase keeps
  // advancing underneath every tick.
  for (let t = 4; t <= 103; t++) {
    const cs = tick(t);
    assertEquals(
      activeActionsSets(cs.sets, id).length,
      0,
      `tick ${t}: a lingering corpse must not re-ship ActiveActions`,
    );
  }
  assertEquals(world.get(id, ActiveActions)?.states["reaction"]?.ticksInPhase, 100);
});
