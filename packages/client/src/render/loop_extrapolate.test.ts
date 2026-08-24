/**
 * extrapolateLoopingLayers (T-363) — pure unit test.
 *
 * The server stops re-shipping AnimationState purely because a looping,
 * fixed-rate layer's `time` advanced (`wireEquals` on the `animationState`
 * component def). Between updates, this function is what keeps that same
 * layer animating smoothly on the client instead of freezing on the last
 * received frame — it must extrapolate ONLY the shape the server actually
 * stopped shipping (`loop: true` + numeric `speedScale`), and leave every
 * other layer (one-shot, velocity-scaled) exactly as received.
 */
import { assertAlmostEquals, assertEquals, assertStrictEquals } from "jsr:@std/assert";
import type { AnimationLayer } from "@voxim/content";
import { extrapolateLoopingLayers } from "./loop_extrapolate.ts";

function layer(over: Partial<AnimationLayer>): AnimationLayer {
  return { clipId: "c", maskId: "", time: 0, loop: false, weight: 1, blend: "override", speedScale: 1, ...over };
}

Deno.test("a looping, numeric-speedScale layer advances by speedScale * elapsed seconds", () => {
  const l = layer({ loop: true, speedScale: 1, time: 0.2 });
  const out = extrapolateLoopingLayers([l], 0, 300); // 300ms elapsed, 1 cycle/sec
  assertAlmostEquals(out[0].time, 0.5, 1e-9);
});

Deno.test("wraps modulo 1 across a loop boundary", () => {
  const l = layer({ loop: true, speedScale: 1, time: 0.8 });
  const out = extrapolateLoopingLayers([l], 0, 500); // +0.5 → 1.3 → wraps to 0.3
  assertAlmostEquals(out[0].time, 0.3, 1e-9);
});

Deno.test("a one-shot (loop: false) layer's time is left untouched", () => {
  const l = layer({ loop: false, speedScale: 1, time: 0.5 });
  const out = extrapolateLoopingLayers([l], 0, 5000);
  assertEquals(out[0].time, 0.5);
});

Deno.test("a velocity-scaled looping layer's time is left untouched (no authoritative client-side speed)", () => {
  const l = layer({ loop: true, speedScale: "velocity", speedReference: 6, time: 0.5 });
  const out = extrapolateLoopingLayers([l], 0, 5000);
  assertEquals(out[0].time, 0.5);
});

Deno.test("zero or negative elapsed time returns the input array unchanged (same reference)", () => {
  const layers = [layer({ loop: true, speedScale: 1, time: 0.1 })];
  assertStrictEquals(extrapolateLoopingLayers(layers, 1000, 1000), layers);
  assertStrictEquals(extrapolateLoopingLayers(layers, 1000, 900), layers);
});

Deno.test("a mixed stack extrapolates only the eligible layer, preserving array order", () => {
  const idle = layer({ clipId: "idle", loop: true, speedScale: 1, time: 0 });
  const swing = layer({ clipId: "swing", loop: false, speedScale: 5, time: 0.3 });
  const out = extrapolateLoopingLayers([idle, swing], 0, 200); // +0.2s
  assertAlmostEquals(out[0].time, 0.2, 1e-9);
  assertEquals(out[0].clipId, "idle");
  assertEquals(out[1].time, 0.3, "the one-shot layer is untouched");
  assertEquals(out[1].clipId, "swing");
});

Deno.test("no eligible layers in the stack returns the input array unchanged (same reference)", () => {
  const layers = [layer({ loop: false })];
  assertStrictEquals(extrapolateLoopingLayers(layers, 0, 1000), layers);
});
