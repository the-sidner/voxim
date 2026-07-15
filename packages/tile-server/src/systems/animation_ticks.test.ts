/**
 * AnimationSystem.deriveTicksIntoAction (T-298) — pure unit test.
 *
 * Locks the generalisation that makes an authored trailing phase (the
 * optional `recovery` phase appended after `winddown`) safe: any phase name
 * other than windup/active/winddown holds `ticksIntoAction` at the swing
 * arc's END value instead of falling through to 0 (which would snap the
 * client's swing pose/trail back to the START of the arc every tick spent in
 * that trailing phase).
 */
import { assertEquals } from "jsr:@std/assert";
import { deriveTicksIntoAction } from "./animation.ts";

const WINDUP = 4, ACTIVE = 6, WINDDOWN = 6; // swing_heavy's geometric arc

Deno.test("deriveTicksIntoAction: windup is always 0 (pre-active, no trail)", () => {
  assertEquals(deriveTicksIntoAction("windup", 0, WINDUP, ACTIVE, WINDDOWN), 0);
  assertEquals(deriveTicksIntoAction("windup", 3, WINDUP, ACTIVE, WINDDOWN), 0);
});

Deno.test("deriveTicksIntoAction: active accumulates on top of windup", () => {
  assertEquals(deriveTicksIntoAction("active", 0, WINDUP, ACTIVE, WINDDOWN), WINDUP);
  assertEquals(deriveTicksIntoAction("active", 2, WINDUP, ACTIVE, WINDDOWN), WINDUP + 2);
});

Deno.test("deriveTicksIntoAction: winddown accumulates on top of windup+active", () => {
  assertEquals(deriveTicksIntoAction("winddown", 0, WINDUP, ACTIVE, WINDDOWN), WINDUP + ACTIVE);
  assertEquals(deriveTicksIntoAction("winddown", 5, WINDUP, ACTIVE, WINDDOWN), WINDUP + ACTIVE + 5);
});

Deno.test("deriveTicksIntoAction: an authored trailing phase (recovery) holds at the arc's END, never resets to 0", () => {
  const total = WINDUP + ACTIVE + WINDDOWN;
  assertEquals(deriveTicksIntoAction("recovery", 0, WINDUP, ACTIVE, WINDDOWN), total);
  assertEquals(deriveTicksIntoAction("recovery", 20, WINDUP, ACTIVE, WINDDOWN), total, "ticksInPhase is irrelevant once past winddown");
});

Deno.test("deriveTicksIntoAction: any unrecognised phase name behaves the same way (generic, not name-specific)", () => {
  const total = WINDUP + ACTIVE + WINDDOWN;
  assertEquals(deriveTicksIntoAction("some_future_phase", 0, WINDUP, ACTIVE, WINDDOWN), total);
});
