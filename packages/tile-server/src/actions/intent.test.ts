/**
 * PrimaryIntentResolver's hold-to-aim branch (T-337).
 *
 * Builds a minimal in-memory ContentService (a `ContentRegistry<ActionDef>` +
 * `ContentRegistry<Prefab>`, cast to the narrow slice PrimaryIntentResolver
 * actually reads) carrying a synthetic hold-to-aim weapon: a draw action
 * (kind:"ambient", finite windup then a perpetual hold, `releaseActionId`
 * set) and a release action (kind:"active"). This exercises the resolver
 * in isolation without depending on real game content's exact tuning.
 *
 * Covers:
 *   - press → starts the draw action, advances through the finite windup
 *     into the perpetual hold entirely via the dispatcher's own phase
 *     advance (the resolver keeps re-requesting the same id — no restart)
 *   - held → same action id every tick while in the perpetual phase
 *   - release (input bit drops) → starts releaseActionId
 *   - ACTION_BLOCK during a hold → cancels into `block`, firing the hold
 *     phase's :exit (verified via the tag it installs — same technique
 *     block.test.ts uses)
 *   - a melee weapon (swingActionId resolves to a kind:"active" def) is
 *     completely unaffected by any of this — same path as before T-337
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { ContentRegistry } from "@voxim/content";
import type { ActionDef, ContentService, Prefab } from "@voxim/content";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { Equipment } from "../components/equipment.ts";
import { InputState } from "../components/game.ts";
import { Blocking, Staggered } from "../components/tags.ts";
import { ACTION_BLOCK, ACTION_USE_SKILL } from "@voxim/protocol";
import { ActionDispatcher } from "./dispatcher.ts";
import { newGateRegistry } from "./gate.ts";
import { newEffectRegistry } from "./effect.ts";
import { setTagResolver, clearTagResolver } from "./resolvers/tags.ts";
import { PrimaryIntentResolver } from "./intent.ts";

const DRAW_WINDUP_TICKS = 3;

function fixtureContent(): ContentService {
  const actions = new ContentRegistry<ActionDef>({ kind: "action", idOf: (a) => a.id });
  actions.register({
    id: "block",
    kind: "ambient",
    slot: "primary",
    phases: { hold: { ticks: -1 } },
    cancel: { hold: { into: ["any"] } },
    movement: { hold: "slowed" },
    effects: [
      { phase: "hold:enter", kind: "set_tag", params: { tag: "blocking" } },
      { phase: "hold:exit", kind: "clear_tag", params: { tag: "blocking" } },
    ],
  });
  actions.register({
    id: "primary_idle",
    kind: "ambient",
    slot: "primary",
    phases: { idle: { ticks: -1 } },
    cancel: { idle: { into: ["any"] } },
    movement: { idle: "free" },
    effects: [],
  });
  actions.register({
    id: "_test_draw",
    kind: "ambient",
    slot: "primary",
    phases: { windup: { ticks: DRAW_WINDUP_TICKS }, hold: { ticks: -1 } },
    cancel: { windup: { into: ["any"] }, hold: { into: ["any"] } },
    movement: { windup: "slowed", hold: "slowed" },
    releaseActionId: "_test_release",
    // "staggered" is just a convenient closed-vocabulary tag to probe
    // hold:enter/:exit firing in this synthetic fixture — no semantic
    // meaning here, distinct from "blocking" (which `block` itself also
    // touches) so cancelling into block can't mask a missing :exit.
    effects: [
      { phase: "hold:enter", kind: "set_tag", params: { tag: "staggered" } },
      { phase: "hold:exit", kind: "clear_tag", params: { tag: "staggered" } },
    ],
  });
  actions.register({
    id: "_test_release",
    kind: "active",
    slot: "primary",
    phases: { active: { ticks: 1 }, winddown: { ticks: 2 } },
    cancel: { active: { into: [] }, winddown: { into: [] } },
    movement: { active: "locked", winddown: "slowed" },
    effects: [],
  });
  actions.register({
    id: "_melee_swing",
    kind: "active",
    slot: "primary",
    phases: { windup: { ticks: 2 }, active: { ticks: 2 }, winddown: { ticks: 2 } },
    cancel: { windup: { into: ["any"] }, active: { into: [] }, winddown: { into: [] } },
    movement: { windup: "slowed", active: "locked", winddown: "slowed" },
    effects: [],
  });

  const prefabs = new ContentRegistry<Prefab>({ kind: "prefab", idOf: (p) => p.id });
  prefabs.register({
    id: "_test_hold_weapon",
    components: { swingable: { swingActionId: "_test_draw", chain: [], heavyChargeMs: 0 } },
  } as unknown as Prefab);
  prefabs.register({
    id: "_test_melee_weapon",
    components: { swingable: { swingActionId: "_melee_swing", chain: [], heavyChargeMs: 999999 } },
  } as unknown as Prefab);

  return { actions, prefabs } as unknown as ContentService;
}

function actor(world: World, weaponPrefabId: string): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["primary"] });
  world.write(id, ActiveActions, { states: {} });
  world.write(id, Equipment, {
    weapon: { entityId: "w1", prefabId: weaponPrefabId },
    offHand: null, head: null, chest: null, legs: null, feet: null, back: null,
  });
  return id;
}

function setActions(world: World, id: string, actions: number): void {
  world.write(id, InputState, {
    facing: 0, pitch: 0, movementX: 0, movementY: 0, actions, chargeMs: 0,
    seq: 0, timestamp: 0, rttMs: 0,
  });
}

function makeDispatcher(content: ContentService): ActionDispatcher {
  const effects = newEffectRegistry();
  effects.register(setTagResolver);
  effects.register(clearTagResolver);
  return new ActionDispatcher(content, newGateRegistry(), effects, new PrimaryIntentResolver(content));
}

Deno.test("T-337: press starts the draw action, holds ACTION_USE_SKILL through the windup into the perpetual hold", () => {
  const content = fixtureContent();
  const world = new World();
  const id = actor(world, "_test_hold_weapon");
  const d = makeDispatcher(content);

  setActions(world, id, ACTION_USE_SKILL);
  for (let t = 0; t <= DRAW_WINDUP_TICKS; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
    assertEquals(world.get(id, ActiveActions)?.states["primary"]?.actionId, "_test_draw", `still drawing at tick ${t}`);
  }
  // Windup has elapsed — the dispatcher's own phase advance carried us into
  // the perpetual "hold" phase; still requesting the SAME action id (still
  // holding ACTION_USE_SKILL).
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.phase, "hold");
});

Deno.test("T-337: held keeps the same action id every tick — no restart while charging", () => {
  const content = fixtureContent();
  const world = new World();
  const id = actor(world, "_test_hold_weapon");
  const d = makeDispatcher(content);

  setActions(world, id, ACTION_USE_SKILL);
  for (let t = 0; t <= DRAW_WINDUP_TICKS; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
  }
  const afterWindup = world.get(id, ActiveActions)?.states["primary"];
  assertEquals(afterWindup?.phase, "hold");

  // Hold for several more ticks — actionId/phase must not reset, ticksInPhase
  // must keep counting up (the same "already running it" no-op every tick).
  for (let t = DRAW_WINDUP_TICKS + 1; t < DRAW_WINDUP_TICKS + 6; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
    const s = world.get(id, ActiveActions)?.states["primary"];
    assertEquals(s?.actionId, "_test_draw");
    assertEquals(s?.phase, "hold");
  }
});

Deno.test("T-337: release (input bit drops) starts releaseActionId", () => {
  const content = fixtureContent();
  const world = new World();
  const id = actor(world, "_test_hold_weapon");
  const d = makeDispatcher(content);

  setActions(world, id, ACTION_USE_SKILL);
  for (let t = 0; t < DRAW_WINDUP_TICKS + 2; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
  }
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.phase, "hold");

  // Release: ACTION_USE_SKILL bit drops.
  setActions(world, id, 0);
  d.prepare(100);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.actionId, "_test_release");
});

Deno.test("T-337: ACTION_BLOCK during a hold cancels the cast — hold's :exit fires (no orphaned tag)", () => {
  const content = fixtureContent();
  const world = new World();
  const id = actor(world, "_test_hold_weapon");
  const d = makeDispatcher(content);

  setActions(world, id, ACTION_USE_SKILL);
  for (let t = 0; t < DRAW_WINDUP_TICKS + 2; t++) {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
  }
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.phase, "hold");

  // Block interrupts unconditionally — the universal out.
  setActions(world, id, ACTION_BLOCK);
  d.prepare(100);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.actionId, "block");
  assert(world.has(id, Blocking), "block's hold:enter fired (cast's hold:exit fired first, cleanly)");
  assert(!world.has(id, Staggered), "the cast's own hold:exit cleared its probe tag — nothing orphaned by the cancel");
});

Deno.test("T-337: a melee weapon (kind:active swingActionId) is unaffected — no hold/release branch taken", () => {
  const content = fixtureContent();
  const world = new World();
  const id = actor(world, "_test_melee_weapon");
  const d = makeDispatcher(content);

  setActions(world, id, ACTION_USE_SKILL);
  d.prepare(0);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.actionId, "_melee_swing");

  // Releasing mid-swing must NOT request any releaseActionId (melee has
  // none) — the swing just runs to completion undisturbed (want=null while
  // swinging, same as before T-337).
  setActions(world, id, 0);
  d.prepare(1);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(world.get(id, ActiveActions)?.states["primary"]?.actionId, "_melee_swing", "swing keeps running to completion");
});
