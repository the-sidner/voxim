/**
 * T-225 — Action loader + validator + bootstrap round-trip.
 *
 * Asserts:
 *   1. JsonSource.load() picks up data/actions/*.json into content.actions
 *   2. validateActionDef rejects malformed defs with id-tagged messages
 *   3. validateActionCrossRefs catches unknown cancel targets and dead globs
 *   4. The first fixture (sword_overhead) round-trips through encodeBootstrap
 *      / decodeBootstrap with its phase / cancel / movement / effect data
 *      fully preserved.
 */

import { assertEquals, assertThrows } from "jsr:@std/assert";
import type { ActionDef } from "./types.ts";
import { JsonSource, validateActionDef, validateActionCrossRefs } from "./loader.ts";
import { encodeBootstrap, decodeBootstrap } from "./bootstrap_codec.ts";

function baseValidAction(): ActionDef {
  return {
    id: "_test",
    kind: "active",
    phases: {
      windup:   { ticks: 4 },
      active:   { ticks: 2 },
      winddown: { ticks: 6 },
    },
    cancel: {
      windup:   { into: [] },
      active:   { into: [] },
      winddown: { into: [] },
    },
    movement: {
      windup:   "slowed",
      active:   "locked",
      winddown: "slowed",
    },
    effects: [],
  };
}

Deno.test("JsonSource loads sword_overhead fixture into content.actions", async () => {
  const content = await JsonSource.load();
  const overhead = content.actions.get("sword_overhead");
  if (!overhead) throw new Error("sword_overhead not registered");
  assertEquals(overhead.kind, "active");
  assertEquals(overhead.phases.windup.ticks, 8);
  assertEquals(overhead.phases.active.ticks, 3);
  assertEquals(overhead.phases.winddown.ticks, 12);
  assertEquals(overhead.movement.active, "locked");
  assertEquals(overhead.effects.length, 1);
  assertEquals(overhead.effects[0].kind, "weapon_trace");
  assertEquals(overhead.effects[0].phase, "active:enter");
});

Deno.test("validateActionDef accepts a minimal well-formed def", () => {
  validateActionDef(baseValidAction());
});

Deno.test("validateActionDef rejects unknown kind", () => {
  const def = baseValidAction();
  // deno-lint-ignore no-explicit-any
  (def as any).kind = "wat";
  assertThrows(() => validateActionDef(def), Error, "kind must be active|reaction|ambient");
});

Deno.test("validateActionDef rejects perpetual phase on non-ambient", () => {
  const def = baseValidAction();
  def.phases.windup.ticks = -1;
  assertThrows(() => validateActionDef(def), Error, "perpetual ticks (-1) is only valid for ambient");
});

Deno.test("validateActionDef accepts perpetual phase on ambient", () => {
  const def: ActionDef = {
    id: "_walk",
    kind: "ambient",
    phases: { loop: { ticks: -1 } },
    cancel: { loop: { into: ["any"] } },
    movement: { loop: "free" },
    effects: [],
  };
  validateActionDef(def);
});

Deno.test("validateActionDef rejects movement on undeclared phase", () => {
  const def = baseValidAction();
  // deno-lint-ignore no-explicit-any
  (def.movement as any).bogus = "free";
  assertThrows(() => validateActionDef(def), Error, "references undeclared phase");
});

Deno.test("validateActionDef rejects missing movement value for a declared phase", () => {
  const def = baseValidAction();
  delete (def.movement as Record<string, unknown>).active;
  assertThrows(() => validateActionDef(def), Error, "movement value required");
});

Deno.test("validateActionDef rejects invalid movement enum", () => {
  const def = baseValidAction();
  // deno-lint-ignore no-explicit-any
  (def.movement as any).active = "frozen";
  assertThrows(() => validateActionDef(def), Error, "free|slowed|locked");
});

Deno.test("validateActionDef rejects malformed effect phase reference", () => {
  const def = baseValidAction();
  def.effects = [{ phase: "active", kind: "weapon_trace" }];
  assertThrows(() => validateActionDef(def), Error, "phaseName>:enter|exit|tick");
});

Deno.test("validateActionDef rejects effect on undeclared phase", () => {
  const def = baseValidAction();
  def.effects = [{ phase: "ghost:enter", kind: "weapon_trace" }];
  assertThrows(() => validateActionDef(def), Error, "effect references undeclared phase");
});

Deno.test("validateActionDef requires interruptPriority on reactions", () => {
  const def = baseValidAction();
  def.kind = "reaction";
  assertThrows(() => validateActionDef(def), Error, "reactions must declare interruptPriority");
});

Deno.test("validateActionCrossRefs rejects unknown explicit cancel target", () => {
  const def = baseValidAction();
  def.id = "swing_a";
  def.cancel.windup.into = ["does_not_exist"];
  assertThrows(() => validateActionCrossRefs([def]), Error, "unknown target 'does_not_exist'");
});

Deno.test("validateActionCrossRefs rejects globs that match no actions", () => {
  const def = baseValidAction();
  def.id = "swing_a";
  def.cancel.windup.into = ["dodge_*"];
  assertThrows(() => validateActionCrossRefs([def]), Error, "matches no loaded actions");
});

Deno.test("validateActionCrossRefs accepts globs once a matching action is present", () => {
  const swing = baseValidAction();
  swing.id = "swing_a";
  swing.cancel.windup.into = ["dodge_*"];
  const dodge: ActionDef = { ...baseValidAction(), id: "dodge_roll" };
  validateActionCrossRefs([swing, dodge]);
});

Deno.test("validateActionCrossRefs accepts the 'any' token without resolution", () => {
  const def = baseValidAction();
  def.id = "interact_long";
  def.cancel.windup.into = ["any"];
  validateActionCrossRefs([def]);
});

Deno.test("sword_overhead fixture round-trips through bootstrap encode/decode", async () => {
  const src = await JsonSource.load();
  const blob = await encodeBootstrap(src);
  const dst = await decodeBootstrap(blob);

  const before = src.actions.getOrThrow("sword_overhead");
  const after  = dst.actions.getOrThrow("sword_overhead");

  assertEquals(after.kind, before.kind);
  assertEquals(after.phases, before.phases);
  assertEquals(after.cancel, before.cancel);
  assertEquals(after.movement, before.movement);
  assertEquals(after.costs, before.costs);
  assertEquals(after.priority, before.priority);
  assertEquals(after.effects, before.effects);
  assertEquals(after.animation, before.animation);
});
