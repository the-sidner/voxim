/**
 * AnimationSystem × sparse delta channel (T-363).
 *
 * AnimationSystem fully replaces AnimationState via `world.set` every tick
 * (T-228: it derives the whole struct fresh, no incremental writes) — and
 * every `world.set` on a networked component becomes a wire delta unless
 * something says otherwise (T-361's physics fix; see
 * `physics_idle_delta.test.ts`). A standing-still actor's locomotion slot
 * still plays its idle *clip* — a looping, fixed-rate animation — so its
 * layer's `time` genuinely advances a real, non-epsilon amount every tick.
 * Before the `wireEquals` gate on the `animationState` component def
 * (T-363), that alone re-shipped the whole AnimationState forever, the
 * "AnimationState clip-time advancing" churn source. `wireEquals` holds
 * the delta back for exactly that shape (a `loop:true`, numeric-speedScale
 * layer's `time`) — client-side, `loop_extrapolate.ts` keeps the same loop
 * animating smoothly between updates by projecting forward from
 * `mesh.lastAnimUpdateMs`, so nothing visibly freezes.
 */
import { assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import type { ChangesetSet } from "@voxim/engine";
import { ActiveActions } from "../components/action.ts";
import { AnimationState } from "../components/game.ts";
import { AnimationSlots } from "../components/animation_slots.ts";
import { AnimationSystem } from "./animation.ts";
import { DeferredEventQueue } from "../deferred_events.ts";

const content = await JsonSource.load();

function spawnIdleActor(world: World): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, AnimationSlots, { slots: { idle: "c_idle", walk_forward: "c_walk" } });
  world.write(id, ActiveActions, {
    states: { locomotion: { actionId: "idle", phase: "hold", ticksInPhase: 0, initiator: "ambient" } },
  });
  world.write(id, AnimationState, { layers: [], weaponActionId: "", ticksIntoAction: 0, dissolutionPhase: 0 });
  return id;
}

/** Networked AnimationState sets for one entity in an applied changeset. */
function animSets(sets: ReadonlyArray<ChangesetSet>, entityId: string): ChangesetSet[] {
  return sets.filter((s) => s.entityId === entityId && s.token === AnimationState);
}

Deno.test("AnimationSystem: a standing-still actor's looping idle clip stops re-shipping AnimationState after the spawn snapshot", () => {
  const world = new World();
  const sys = new AnimationSystem(content);
  const id = spawnIdleActor(world);

  // Tick 1: the very first commit — must ship (nothing to compare against yet).
  sys.run(world, new DeferredEventQueue(), 1 / 20);
  const first = world.applyChangeset();
  assertEquals(animSets(first.sets, id).length, 1, "the initial snapshot must still reach the wire");

  // The idle clip is a real, normalized-1s loop — every tick advances its
  // layer's `time` by a real (non-epsilon) amount, so this pins actual
  // steady-state suppression, not a lucky float coincidence.
  const t1 = world.get(id, AnimationState)!.layers[0]?.time;

  for (let t = 2; t <= 21; t++) {
    sys.run(world, new DeferredEventQueue(), 1 / 20);
    const changeset = world.applyChangeset();
    assertEquals(
      animSets(changeset.sets, id).length,
      0,
      `tick ${t}: a standing-still actor must not re-ship AnimationState for clip-time alone`,
    );
  }

  // The committed value keeps advancing underneath (correctness, not just
  // wire-silence) — the clip has looped several times over 20 more ticks at
  // 1 cycle/sec, so it must differ from the tick-1 snapshot.
  const tLater = world.get(id, AnimationState)!.layers[0]?.time;
  assertEquals(typeof tLater, "number");
  assertEquals(tLater === t1 && tLater === 0, false, "clip time must keep advancing internally even while silent on the wire");
});

Deno.test("AnimationSystem: a real animation change (locomotion clip swap) still ships", () => {
  const world = new World();
  const sys = new AnimationSystem(content);
  const id = spawnIdleActor(world);

  sys.run(world, new DeferredEventQueue(), 1 / 20);
  world.applyChangeset();

  // Swap the running locomotion action — a genuinely different clip.
  world.write(id, ActiveActions, {
    states: { locomotion: { actionId: "walk_forward", phase: "hold", ticksInPhase: 0, initiator: "intent" } },
  });

  sys.run(world, new DeferredEventQueue(), 1 / 20);
  const changeset = world.applyChangeset();
  const sets = animSets(changeset.sets, id);
  assertEquals(sets.length, 1, "a clip change must ship exactly one delta");
  const layers = (sets[0].data as { layers: { clipId: string }[] }).layers;
  assertEquals(layers[0]?.clipId, "c_walk");
});
