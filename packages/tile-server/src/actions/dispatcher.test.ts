/**
 * ActionDispatcher semantics (T-226).
 *
 * Validates the substrate against a minimal World + StaticContentStore with
 * hand-built ActionDefs — no JSON load, no game components. Covers: phase
 * advancement + effect edges, perpetual ambient phases, precondition gates,
 * cost gating, the cancel matrix (exact / glob / "any" / committed), reaction
 * interrupt priority, and ambient swap via intent.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { StaticContentStore } from "@voxim/content";
import type { ActionDef } from "@voxim/content";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import type { ActiveActionState } from "../components/action.ts";
import { ActionDispatcher } from "./dispatcher.ts";
import type { IntentResolver, CostHandler } from "./dispatcher.ts";
import { newGateRegistry } from "./gate.ts";
import { newEffectRegistry } from "./effect.ts";

function content(...defs: ActionDef[]): StaticContentStore {
  const s = new StaticContentStore();
  for (const d of defs) s.registerAction(d);
  return s;
}

function actor(world: World, slots: string[]): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots });
  world.write(id, ActiveActions, { states: {} });
  return id;
}

function slotState(world: World, id: string, slot: string): ActiveActionState | undefined {
  return world.get(id, ActiveActions)?.states[slot];
}

/** IntentResolver that returns a fixed desire for one slot, once-per-tick. */
function fixedIntent(slot: string, actionId: string | null): IntentResolver {
  return { resolve: () => new Map([[slot, actionId]]) };
}

const swing: ActionDef = {
  id: "swing", kind: "active", slot: "primary",
  phases: { windup: { ticks: 2 }, active: { ticks: 2 }, winddown: { ticks: 2 } },
  cancel: { windup: { into: ["dodge_*", "block"] }, active: { into: [] }, winddown: { into: ["any"] } },
  movement: { windup: "slowed", active: "locked", winddown: "slowed" },
  effects: [
    { phase: "windup:enter", kind: "rec" },
    { phase: "active:enter", kind: "rec" },
    { phase: "active:tick", kind: "rec" },
    { phase: "winddown:exit", kind: "rec" },
  ],
};

Deno.test("dispatcher advances phases and clears the slot on completion", () => {
  const world = new World();
  const fired: string[] = [];
  const gates = newGateRegistry();
  const effects = newEffectRegistry();
  effects.register({ id: "rec", resolve: (c) => fired.push(`${c.state.phase}:${c.edge}`) });

  const id = actor(world, ["primary"]);
  // Seed a running swing directly (intent path covered separately).
  world.write(id, ActiveActions, {
    states: { primary: { actionId: "swing", phase: "windup", ticksInPhase: 0, initiator: "intent" } },
  });

  const d = new ActionDispatcher(content(swing), gates, effects);

  // windup:2 → ticks 0,1 ; active:2 ; winddown:2 ; then complete.
  for (let i = 0; i < 7; i++) {
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
  }

  // enter fired on windup(seed had tick0 so :tick skipped), active, plus
  // active:tick while in active, winddown:exit at the end.
  assert(fired.includes("active:enter"), `saw ${fired.join(",")}`);
  assert(fired.includes("active:tick"), `saw ${fired.join(",")}`);
  assert(fired.includes("winddown:exit"), `saw ${fired.join(",")}`);
  assertEquals(slotState(world, id, "primary"), undefined); // slot cleared
});

Deno.test("perpetual ambient phase never completes and ticks every tick", () => {
  const world = new World();
  let ticks = 0;
  const effects = newEffectRegistry();
  effects.register({ id: "loop", resolve: (c) => { if (c.edge === "tick") ticks++; } });
  const idle: ActionDef = {
    id: "idle", kind: "ambient", slot: "locomotion",
    phases: { loop: { ticks: -1 } },
    cancel: { loop: { into: ["any"] } },
    movement: { loop: "free" },
    effects: [{ phase: "loop:tick", kind: "loop" }],
  };
  const id = actor(world, ["locomotion"]);
  world.write(id, ActiveActions, {
    states: { locomotion: { actionId: "idle", phase: "loop", ticksInPhase: 0, initiator: "ambient" } },
  });
  const d = new ActionDispatcher(content(idle), newGateRegistry(), effects);
  for (let i = 0; i < 5; i++) { d.run(world, new EventBus(), 1 / 20); world.applyChangeset(); }
  assertEquals(slotState(world, id, "locomotion")?.actionId, "idle"); // still running
  assert(ticks >= 4, `expected sustained ticks, got ${ticks}`);
});

Deno.test("precondition gate blocks start; passing gate admits it", () => {
  const mk = (allow: boolean) => {
    const world = new World();
    const gates = newGateRegistry();
    gates.register({ id: "ok", test: () => allow });
    const def: ActionDef = {
      id: "guarded", kind: "active", slot: "primary",
      phases: { p: { ticks: 3 } }, cancel: { p: { into: [] } }, movement: { p: "free" },
      preconditions: [{ gate: "ok" }], effects: [],
    };
    const id = actor(world, ["primary"]);
    const d = new ActionDispatcher(content(def), gates, newEffectRegistry(), fixedIntent("primary", "guarded"));
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
    return slotState(world, id, "primary");
  };
  assertEquals(mk(false), undefined);          // gate failed → not started
  assertEquals(mk(true)?.actionId, "guarded"); // gate passed → started
});

Deno.test("cost handler gates start and deducts on success", () => {
  const world = new World();
  let deducted = 0;
  const costs: CostHandler = {
    affordable: () => true,
    deduct: (_w, _e, c) => { deducted += c.stamina ?? 0; },
  };
  const def: ActionDef = {
    id: "costly", kind: "active", slot: "primary",
    phases: { p: { ticks: 2 } }, cancel: { p: { into: [] } }, movement: { p: "free" },
    costs: { stamina: 12 }, effects: [],
  };
  const id = actor(world, ["primary"]);
  const d = new ActionDispatcher(content(def), newGateRegistry(), newEffectRegistry(), fixedIntent("primary", "costly"), costs);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(slotState(world, id, "primary")?.actionId, "costly");
  assertEquals(deducted, 12);
});

Deno.test("unaffordable cost blocks start", () => {
  const world = new World();
  const costs: CostHandler = { affordable: () => false, deduct: () => {} };
  const def: ActionDef = {
    id: "costly", kind: "active", slot: "primary",
    phases: { p: { ticks: 2 } }, cancel: { p: { into: [] } }, movement: { p: "free" },
    costs: { stamina: 999 }, effects: [],
  };
  const id = actor(world, ["primary"]);
  const d = new ActionDispatcher(content(def), newGateRegistry(), newEffectRegistry(), fixedIntent("primary", "costly"), costs);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(slotState(world, id, "primary"), undefined);
});

Deno.test("cancel matrix: glob admits, committed phase rejects", () => {
  const dodge: ActionDef = {
    id: "dodge_roll", kind: "active", slot: "primary",
    phases: { p: { ticks: 2 } }, cancel: { p: { into: [] } }, movement: { p: "free" }, effects: [],
  };
  // windup admits dodge_* ; active is committed (into: []).
  const run = (seedPhase: string) => {
    const world = new World();
    const id = actor(world, ["primary"]);
    world.write(id, ActiveActions, {
      states: { primary: { actionId: "swing", phase: seedPhase, ticksInPhase: 0, initiator: "intent" } },
    });
    const d = new ActionDispatcher(
      content(swing, dodge), newGateRegistry(), newEffectRegistry(),
      fixedIntent("primary", "dodge_roll"),
    );
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
    return slotState(world, id, "primary")?.actionId;
  };
  assertEquals(run("windup"), "dodge_roll"); // glob dodge_* admitted
  assertEquals(run("active"), "swing");      // committed → cancel rejected
});

Deno.test("reaction interrupt priority bypasses the cancel matrix", () => {
  const flinch: ActionDef = {
    id: "flinch", kind: "reaction", slot: "primary", interruptPriority: 10,
    phases: { p: { ticks: 3 } }, cancel: { p: { into: [] } }, movement: { p: "locked" }, effects: [],
  };
  const world = new World();
  const id = actor(world, ["primary"]);
  // swing.active is committed (into: []), priority defaults to 0.
  world.write(id, ActiveActions, {
    states: { primary: { actionId: "swing", phase: "active", ticksInPhase: 0, initiator: "intent" } },
  });
  const d = new ActionDispatcher(
    content(swing, flinch), newGateRegistry(), newEffectRegistry(),
    fixedIntent("primary", "flinch"),
  );
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  const s = slotState(world, id, "primary");
  assertEquals(s?.actionId, "flinch");
  assertEquals(s?.initiator, "event");
});

Deno.test("ambient swap via intent cancels current and starts the new one", () => {
  const idle: ActionDef = {
    id: "idle", kind: "ambient", slot: "locomotion",
    phases: { loop: { ticks: -1 } }, cancel: { loop: { into: ["any"] } },
    movement: { loop: "free" }, effects: [],
  };
  const walk: ActionDef = {
    id: "walk", kind: "ambient", slot: "locomotion",
    phases: { loop: { ticks: -1 } }, cancel: { loop: { into: ["any"] } },
    movement: { loop: "free" }, effects: [],
  };
  const world = new World();
  const id = actor(world, ["locomotion"]);
  world.write(id, ActiveActions, {
    states: { locomotion: { actionId: "idle", phase: "loop", ticksInPhase: 5, initiator: "ambient" } },
  });
  const d = new ActionDispatcher(
    content(idle, walk), newGateRegistry(), newEffectRegistry(),
    fixedIntent("locomotion", "walk"),
  );
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(slotState(world, id, "locomotion")?.actionId, "walk");
});

Deno.test("action whose slot the actor does not declare is rejected", () => {
  const def: ActionDef = {
    id: "mount_up", kind: "active", slot: "mount",
    phases: { p: { ticks: 2 } }, cancel: { p: { into: [] } }, movement: { p: "free" }, effects: [],
  };
  const world = new World();
  const id = actor(world, ["locomotion", "primary"]); // no "mount" slot
  const d = new ActionDispatcher(content(def), newGateRegistry(), newEffectRegistry(), fixedIntent("mount", "mount_up"));
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(slotState(world, id, "mount"), undefined);
});
