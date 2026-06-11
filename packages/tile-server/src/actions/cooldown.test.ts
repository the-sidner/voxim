/**
 * Action cooldowns as a dispatcher primitive (T-260).
 *
 * `ActionDef.cooldownTicks` blocks the same action from restarting until
 * it ticks down; `triggersGcd` raises the actor's global cooldown
 * (game_config.lore.globalCooldownTicks) and is blocked while it runs.
 * Stamped on actual start only — a request rejected by the cancel matrix
 * burns nothing. Per-action, not per-bar-slot (the WoW model).
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource, StaticContentStore } from "@voxim/content";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { ActionCooldowns } from "../components/action_cooldowns.ts";
import { ActionDispatcher } from "./dispatcher.ts";
import type { IntentResolver } from "./dispatcher.ts";
import { newGateRegistry } from "./gate.ts";
import { newEffectRegistry } from "./effect.ts";

const content = await JsonSource.load() as StaticContentStore;

// Two instant test actions: one with a per-action CD only, one GCD-only.
content.registerAction({
  id: "test_cd_blast", kind: "active", slot: "primary",
  phases: { act: { ticks: 1 } },
  cancel: { act: { into: [] } },
  movement: { act: "free" },
  cooldownTicks: 3,
  effects: [],
});
content.registerAction({
  id: "test_gcd_blast", kind: "active", slot: "primary",
  phases: { act: { ticks: 1 } },
  cancel: { act: { into: [] } },
  movement: { act: "free" },
  cooldownTicks: 3, triggersGcd: true,
  effects: [],
});
content.registerAction({
  id: "test_gcd_jab", kind: "active", slot: "primary",
  phases: { act: { ticks: 1 } },
  cancel: { act: { into: [] } },
  movement: { act: "free" },
  triggersGcd: true,
  effects: [],
});

function harness(wantId: string | null) {
  const world = new World();
  let want = wantId;
  const intent: IntentResolver = { resolve: () => new Map([["primary", want]]) };
  const d = new ActionDispatcher(content, newGateRegistry(), newEffectRegistry(), intent);
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["primary"] });
  world.write(id, ActiveActions, { states: {} });
  const tick = (t: number) => {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
  };
  const running = () => world.get(id, ActiveActions)?.states["primary"]?.actionId ?? null;
  return { world, id, tick, running, setWant: (w: string | null) => { want = w; } };
}

Deno.test("cooldownTicks: stamped on start, blocks restart, ticks down, then frees", () => {
  const h = harness("test_cd_blast");

  h.tick(1);
  assertEquals(h.running(), "test_cd_blast", "starts clean");
  assertEquals(h.world.get(h.id, ActionCooldowns)!.remaining["test_cd_blast"], 3, "CD stamped");

  // The 1-tick action completes; intent keeps wanting it — blocked while
  // the CD runs (committed view reads ≤1 tick high — accepted retune).
  let restarted = 0;
  for (let t = 2; t <= 6; t++) {
    h.tick(t);
    if (h.running() === "test_cd_blast") restarted++;
  }
  assertEquals(restarted, 1, "exactly one restart once the CD expired");
  assert((h.world.get(h.id, ActionCooldowns)!.remaining["test_cd_blast"] ?? 0) > 0, "fresh stamp after restart");
});

Deno.test("triggersGcd: one cast locks a different GCD action out until the GCD expires", () => {
  const h = harness("test_gcd_blast");
  const gcdTicks = content.getGameConfig().lore.globalCooldownTicks;

  h.tick(1);
  assertEquals(h.world.get(h.id, ActionCooldowns)!.gcd, gcdTicks, "GCD raised");

  // Switch intent to the other GCD action — blocked while the GCD runs.
  h.setWant("test_gcd_jab");
  h.tick(2);
  assertEquals(h.running(), null, "GCD blocks the second skill");

  // Tick through the GCD window: the jab starts exactly once, only after
  // the GCD expired (the 1-tick action completes the tick after starting,
  // so count starts rather than asserting at a fixed tick).
  let starts = 0;
  let firstStartTick = 0;
  for (let t = 3; t <= 2 + gcdTicks + 3; t++) {
    h.tick(t);
    if (h.running() === "test_gcd_jab") {
      starts++;
      if (firstStartTick === 0) firstStartTick = t;
    }
  }
  assertEquals(starts, 1, "the jab started exactly once in the window");
  assert(firstStartTick > gcdTicks, `started only after the GCD (t=${firstStartTick})`);
});

Deno.test("actions without cooldown fields never touch ActionCooldowns", () => {
  const h = harness("idle"); // real content locomotion action, no CD fields
  // idle is slot locomotion, not primary — intent targets primary, so
  // nothing starts; the point is the decrement pass tolerates absence.
  h.tick(1);
  assertEquals(h.world.has(h.id, ActionCooldowns), false);
});
