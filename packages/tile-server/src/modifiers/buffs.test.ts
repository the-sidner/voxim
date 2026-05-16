/**
 * Buff-as-scene-graph-child machinery (T-239 phase 2a) — inert wiring
 * proof. Nothing in the server spawns a buff yet; this drives the pieces
 * directly to lock the contract phase 2b depends on:
 *
 *   start_buff → child with BuffSpec + buff_timer Resource + buff action
 *   buffs source → reads the child's BuffSpec as a StatModifier
 *   ResourceSystem ticks buff_timer → cross@0 → expire_buff → child gone
 *   buff_tick → DoT applied to the parent's Health
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Health } from "../components/game.ts";
import { Resource } from "../components/resource.ts";
import { BuffSpec } from "../components/buff.ts";
import { ResourceSystem } from "../systems/resource.ts";
import { newResourceEffectRegistry } from "../resources/effect.ts";
import { newResourceModifierRegistry } from "../resources/modifier.ts";
import { expireBuffEffect } from "../resources/effects/expire_buff.ts";
import { startBuffResolver, buffTickResolver } from "../actions/resolvers/buff.ts";
import { effective, newModifierSourceRegistry } from "./modifier.ts";
import { buffsSource } from "./sources/buffs.ts";
import type { DeathRequestPort } from "../events/death.ts";
import type { ResolveContext } from "../actions/effect.ts";

const content = await JsonSource.load();
const noDeaths: DeathRequestPort = { request: () => {} };

function rctx(world: World, entityId: string, params: Record<string, unknown>): ResolveContext {
  return {
    world, events: new EventBus(), entityId, slot: "skill",
    state: { actionId: "x", phase: "p", ticksInPhase: 0, initiator: "intent" },
    content, params, edge: "enter", serverTick: 0,
  };
}

Deno.test("start_buff spawns a child the buffs source reads as a modifier", () => {
  const w = new World();
  const actor = newEntityId();
  w.create(actor);

  startBuffResolver.resolve(rctx(w, actor, {
    stat: "moveSpeed", op: "mul", value: 0.7, durationTicks: 80,
  }));

  const children = w.getChildren(actor);
  assertEquals(children.length, 1);
  const spec = w.get(children[0], BuffSpec)!;
  assertEquals(spec, { stat: "moveSpeed", op: "mul", value: 0.7, tickDelta: 0 });
  assertEquals(w.get(children[0], Resource)!.values.buff_timer, { value: 80, max: 80 });

  const reg = newModifierSourceRegistry();
  reg.register(buffsSource);
  // moveSpeed base 1 × 0.7 (the buff child's mul) = 0.7
  assertEquals(effective(reg, { world: w, content, entityId: actor }, "moveSpeed", 1), 0.7);
});

Deno.test("buff_timer counts down → expire_buff destroys the child", () => {
  const fx = newResourceEffectRegistry();
  fx.register(expireBuffEffect);
  const sys = new ResourceSystem(content, fx, newResourceModifierRegistry(), noDeaths);

  const w = new World();
  const actor = newEntityId();
  w.create(actor);
  startBuffResolver.resolve(rctx(w, actor, {
    stat: "moveSpeed", op: "mul", value: 0.5, durationTicks: 40,
  }));
  const child = w.getChildren(actor)[0];
  assert(w.isAlive(child), "child spawned");

  for (let i = 0; i < 60; i++) {
    sys.run(w, new EventBus(), 1 / 20);
    w.applyChangeset();
  }
  assertEquals(w.getChildren(actor).length, 0); // destroySubtree on expiry
  assert(!w.isAlive(child), "buff child torn down");
});

Deno.test("buff_tick applies a DoT to the parent's Health", () => {
  const w = new World();
  const actor = newEntityId();
  w.create(actor);
  w.write(actor, Health, { current: 100, max: 100 });
  startBuffResolver.resolve(rctx(w, actor, {
    stat: "health", op: "add", value: 0, durationTicks: 100, tickDelta: -3,
  }));
  const child = w.getChildren(actor)[0];

  buffTickResolver.resolve(rctx(w, child, {}));
  w.applyChangeset();
  assertEquals(w.get(actor, Health)!.current, 97);
});
