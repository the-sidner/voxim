/**
 * facingFromMove is the T-320 movement-heading facing rule. The load-bearing
 * contract is HOLD-WHEN-IDLE: a naive atan2(0,0) snaps idle facing to east on
 * key-release (a visible body flick), so the idle branch must return `prev`
 * untouched. Pure → deterministic.
 */
import { assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { facingFromMove } from "./facing.ts";

Deno.test("faces the movement direction while moving (east)", () => {
  assertAlmostEquals(facingFromMove(2.0, 1, 0), 0, 1e-12);
});

Deno.test("faces the movement direction while moving (north)", () => {
  assertAlmostEquals(facingFromMove(0, 0, 1), Math.PI / 2, 1e-12);
});

Deno.test("faces the movement direction while moving (diagonal SW)", () => {
  assertAlmostEquals(facingFromMove(0, -1, -1), Math.atan2(-1, -1), 1e-12);
});

Deno.test("HOLDS the previous facing when idle (no snap to east)", () => {
  // Was facing north, key released → stays north, does NOT become 0.
  assertEquals(facingFromMove(Math.PI / 2, 0, 0), Math.PI / 2);
  // Arbitrary held value is preserved verbatim.
  assertEquals(facingFromMove(-1.234, 0, 0), -1.234);
});

Deno.test("move → release sequence holds the last moving heading", () => {
  let f = 0;
  f = facingFromMove(f, 0, 1);   // move north
  assertAlmostEquals(f, Math.PI / 2, 1e-12);
  f = facingFromMove(f, 0, 0);   // release
  assertAlmostEquals(f, Math.PI / 2, 1e-12);
  f = facingFromMove(f, 0, 0);   // still idle
  assertAlmostEquals(f, Math.PI / 2, 1e-12);
});
