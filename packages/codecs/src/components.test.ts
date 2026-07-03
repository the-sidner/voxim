/**
 * animationStateCodec round-trip tests (T-311 P5c). No per-field byte-layout
 * test existed for this codec before — `codec_registry.test.ts` only asserts
 * wireId set-membership (which `animationState`, wireId 14, already had), not
 * field shape, so the dissolutionPhase addition needed a NEW test, not an
 * "extended" one.
 */
import { assertEquals } from "jsr:@std/assert";
import { animationStateCodec } from "./components.ts";
import type { AnimationStateData } from "@voxim/content";

function roundTrip(v: AnimationStateData): AnimationStateData {
  return animationStateCodec.decode(animationStateCodec.encode(v));
}

Deno.test("animationStateCodec: round-trips dissolutionPhase at 0 (the common case)", () => {
  const v: AnimationStateData = {
    layers: [],
    weaponActionId: "",
    ticksIntoAction: 0,
    dissolutionPhase: 0,
  };
  assertEquals(roundTrip(v), v);
});

Deno.test("animationStateCodec: round-trips dissolutionPhase mid-dissolve (0.5)", () => {
  const v: AnimationStateData = {
    layers: [],
    weaponActionId: "",
    ticksIntoAction: 0,
    dissolutionPhase: 0.5,
  };
  assertEquals(roundTrip(v), v);
});

Deno.test("animationStateCodec: round-trips dissolutionPhase fully dissolved (1) alongside populated layers", () => {
  const v: AnimationStateData = {
    layers: [
      {
        clipId: "zombie_dying",
        maskId: "",
        time: Math.fround(0.9),
        weight: 1,
        blend: "override",
        speedScale: 1.25,
        speedReference: undefined,
      },
      {
        clipId: "zombie_walk",
        maskId: "lower_body",
        time: Math.fround(0.2),
        weight: 0.5,
        blend: "additive",
        speedScale: "velocity",
        speedReference: 4.5,
      },
    ],
    weaponActionId: "slash",
    ticksIntoAction: 12,
    dissolutionPhase: 1,
  };
  assertEquals(roundTrip(v), v);
});
