/**
 * projectLocomotion (T-226c) — behavioral parity with the retired CSM
 * locomotion layer. Asserts the emitted AnimationLayer matches what the
 * old `effectiveState` + `resolveSpeedScale` + `computeClipTime` produced:
 * clip resolution, the crouch variant, loop, speedScale (velocity / auto
 * 1÷phase-duration for one-shots), full-body mask, and clip-time advance.
 *
 * Uses the real action library (JsonSource) for the action defs + a
 * synthetic animationSlots map for clip resolution.
 */

import { assertEquals } from "jsr:@std/assert";
import { JsonSource } from "@voxim/content";
import { projectLocomotion } from "./animation.ts";
import type { ActiveActionState } from "../components/action.ts";

const SLOTS: Record<string, string> = {
  idle: "c_idle",
  crouch_idle: "c_crouch_idle",
  walk_forward: "c_wf",
  crouch_walk_forward: "c_cwf",
  jump: "c_jump",
  sidestep: "c_ss",
};
const WALK_REF = 6; // arbitrary; only ratios matter
const DT = 1 / 20;

function st(actionId: string, phase: string, ticks = 0): ActiveActionState {
  return { actionId, phase, ticksInPhase: ticks, initiator: "ambient" };
}

const content = await JsonSource.load();

Deno.test("idle: loop, speedScale 1, full-body mask, no crouch", () => {
  const l = projectLocomotion(content, st("idle", "hold"), false, SLOTS, new Map(), 0, WALK_REF);
  assertEquals(l?.clipId, "c_idle");
  assertEquals(l?.maskId, "");
  assertEquals(l?.speedScale, 1);
  assertEquals(l?.weight, 1);
  assertEquals(l?.time, (0 + 1 * DT) % 1); // loop advance at 1 cycle/sec
});

Deno.test("crouch variant swaps the clip when the Crouched tag is set", () => {
  const l = projectLocomotion(content, st("idle", "hold"), true, SLOTS, new Map(), 0, WALK_REF);
  assertEquals(l?.clipId, "c_crouch_idle");
});

Deno.test("walk_forward ties playback to ground speed (speedScale velocity)", () => {
  const speed = 3;
  const l = projectLocomotion(content, st("walk_forward", "hold"), false, SLOTS, new Map(), speed, WALK_REF);
  assertEquals(l?.clipId, "c_wf");
  assertEquals(l?.speedScale, "velocity");
  assertEquals(l?.speedReference, WALK_REF);
  assertEquals(l?.time, (0 + (speed / WALK_REF) * DT) % 1);
});

Deno.test("walk_forward crouched → crouch clip, still velocity-scaled", () => {
  const l = projectLocomotion(content, st("walk_forward", "hold"), true, SLOTS, new Map(), 1, WALK_REF);
  assertEquals(l?.clipId, "c_cwf");
  assertEquals(l?.speedScale, "velocity");
});

Deno.test("jump one-shot auto-fits speedScale = 1 / phase-duration (8t → 2.5)", () => {
  const l = projectLocomotion(content, st("jump", "rise"), false, SLOTS, new Map(), 0, WALK_REF);
  assertEquals(l?.clipId, "c_jump");
  assertEquals(l?.speedScale, 1 / (8 * DT)); // 2.5
  assertEquals(l?.speedReference, undefined); // not velocity
  assertEquals(l?.time, Math.min(0 + (1 / (8 * DT)) * DT, 1));
});

Deno.test("sidestep one-shot: 5t → speedScale 4.0", () => {
  const l = projectLocomotion(content, st("sidestep", "hop"), false, SLOTS, new Map(), 0, WALK_REF);
  assertEquals(l?.speedScale, 1 / (5 * DT)); // 4.0
});

Deno.test("empty slot falls back to idle (no rest-pose flash on tick 1)", () => {
  const l = projectLocomotion(content, undefined, false, SLOTS, new Map(), 0, WALK_REF);
  assertEquals(l?.clipId, "c_idle");
});

Deno.test("clip-time accumulates from the prior tick keyed by resolved clip", () => {
  const prev = new Map([["c_idle", 0.4]]);
  const l = projectLocomotion(content, st("idle", "hold"), false, SLOTS, prev, 0, WALK_REF);
  assertEquals(l?.time, (0.4 + 1 * DT) % 1);
});
