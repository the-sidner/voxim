/**
 * Telegraph lead clip (T-297) — pure unit test of `computeTelegraphLayer`.
 * No renderer/scene needed: a fake ActionDef map + hand-built ActiveActions
 * snapshots prove the tell plays for exactly `preWindup.ticks`, falls back
 * cleanly when absent, and never plays outside the action's first phase.
 */
import { assertEquals } from "jsr:@std/assert";
import type { ActionDef } from "@voxim/content";
import type { ActiveActionsData } from "@voxim/codecs";
import { computeTelegraphLayer } from "./telegraph.ts";

const NOW = 1_000_000;

function actionsMap(defs: Partial<ActionDef>[]): (id: string) => ActionDef | undefined {
  const m = new Map(defs.map((d) => [d.id as string, d as ActionDef]));
  return (id) => m.get(id);
}

const SWING_WITH_TELL: Partial<ActionDef> = {
  id: "swing_heavy",
  phases: { windup: { ticks: 4 }, active: { ticks: 6 }, winddown: { ticks: 6 } },
  preWindup: { clipId: "tell_clip", ticks: 2 },
};

const SWING_NO_TELL: Partial<ActionDef> = {
  id: "swing_light",
  phases: { windup: { ticks: 2 }, active: { ticks: 4 }, winddown: { ticks: 2 } },
};

function activeActions(actionId: string, phase: string, ticksInPhase: number): ActiveActionsData {
  return { states: { primary: { actionId, phase, ticksInPhase, initiator: "intent" } } };
}

Deno.test("telegraph: plays the tell clip at the start of windup", () => {
  const getAction = actionsMap([SWING_WITH_TELL]);
  const layer = computeTelegraphLayer(activeActions("swing_heavy", "windup", 0), getAction, NOW, NOW);
  assertEquals(layer?.clipId, "tell_clip");
  assertEquals(layer?.weight, 1);
});

Deno.test("telegraph: stops once ticksInPhase reaches preWindup.ticks", () => {
  const getAction = actionsMap([SWING_WITH_TELL]);
  // Still inside (ticks=1 < 2)
  assertEquals(computeTelegraphLayer(activeActions("swing_heavy", "windup", 1), getAction, NOW, NOW) !== null, true);
  // At the boundary (ticks=2 >= 2) — the real windup clip takes over.
  assertEquals(computeTelegraphLayer(activeActions("swing_heavy", "windup", 2), getAction, NOW, NOW), null);
});

Deno.test("telegraph: absent for an action with no preWindup", () => {
  const getAction = actionsMap([SWING_NO_TELL]);
  const layer = computeTelegraphLayer(activeActions("swing_light", "windup", 0), getAction, NOW, NOW);
  assertEquals(layer, null);
});

Deno.test("telegraph: never plays outside the action's first phase", () => {
  const getAction = actionsMap([SWING_WITH_TELL]);
  const layer = computeTelegraphLayer(activeActions("swing_heavy", "active", 0), getAction, NOW, NOW);
  assertEquals(layer, null, "active phase is not the first phase — no tell mid-swing");
});

Deno.test("telegraph: absent when there is no primary slot at all", () => {
  const getAction = actionsMap([SWING_WITH_TELL]);
  assertEquals(computeTelegraphLayer(null, getAction, NOW, NOW), null);
  assertEquals(computeTelegraphLayer({ states: {} }, getAction, NOW, NOW), null);
});

Deno.test("telegraph: extrapolates sub-tick between server updates", () => {
  const getAction = actionsMap([SWING_WITH_TELL]);
  // ticksInPhase=0 latched 25ms ago (half a 50ms tick) — should still read
  // as mid-tell (0.5/2 ticks in), not yet past the 2-tick window.
  const layer = computeTelegraphLayer(activeActions("swing_heavy", "windup", 0), getAction, NOW - 25, NOW);
  assertEquals(layer !== null, true);
  assertEquals(layer!.time > 0 && layer!.time < 1, true);
});
