/**
 * IntentTranslator is the T-328 facing owner + camera-relative-turned-facing-
 * relative movement basis. The load-bearing contracts:
 *
 *  - `applyLookDelta` accumulates facing from raw mouse-X (via
 *    `facingFromLook`), independent of any key state — a press alone never
 *    moves it.
 *  - `buildDatagram`'s movement vector is transformed by the FACING basis:
 *    a pure W press is forward-along-facing, a pure A/D press is a STRAFE
 *    perpendicular to facing (not a turn), and none of WASD mutates facing
 *    (T-320's `facingFromMove` is gone — facing is mouse-only now).
 */
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import { hasAction, ACTION_USE_SKILL } from "@voxim/protocol";
import { IntentRouter } from "./intent_router.ts";
import { IntentTranslator } from "./intent_translator.ts";

// pressKey/applyLookDelta/buildDatagram never touch modeState/uiState (those
// only gate the mouse-click handlers), so no signal reset is needed here.
function freshTranslator(): IntentTranslator {
  const t = new IntentTranslator(new IntentRouter());
  // sensitivity = 1 rad/pixel makes the math trivial to assert against.
  t.configure({ mouseSensitivity: 1 });
  return t;
}

Deno.test("applyLookDelta accumulates facing from dx, wrapped continuously", () => {
  const t = freshTranslator();
  assertAlmostEquals(t.facing, 0, 1e-12);
  t.applyLookDelta(1);
  assertAlmostEquals(t.facing, 1, 1e-12);
  t.applyLookDelta(1);
  assertAlmostEquals(t.facing, 2, 1e-12);
  // Wraps into (-π, π] rather than growing unbounded.
  t.applyLookDelta(10);
  assertEquals(t.facing > -Math.PI && t.facing <= Math.PI, true);
});

Deno.test("a pure A press strafes perpendicular to facing, not a turn", () => {
  const t = freshTranslator();
  t.applyLookDelta(0.7); // arbitrary non-axis-aligned facing
  const facingBefore = t.facing;

  t.pressKey("KeyA");
  const d = t.buildDatagram(1, 1);

  // Facing did not move — WASD no longer derives it (T-320's rule is gone).
  assertAlmostEquals(t.facing, facingBefore, 1e-12);
  assertEquals(d.facing, facingBefore);

  // The movement vector is perpendicular to the facing direction.
  const facingDirX = Math.cos(facingBefore), facingDirY = Math.sin(facingBefore);
  const dot = d.movementX * facingDirX + d.movementY * facingDirY;
  assertAlmostEquals(dot, 0, 1e-9);
});

Deno.test("a pure W press moves exactly along facing", () => {
  const t = freshTranslator();
  t.applyLookDelta(-1.4);
  const facing = t.facing;

  t.pressKey("KeyW");
  const d = t.buildDatagram(1, 1);

  assertAlmostEquals(d.movementX, Math.cos(facing), 1e-9);
  assertAlmostEquals(d.movementY, Math.sin(facing), 1e-9);
});

Deno.test("a pure S press back-pedals: opposite of facing, facing unchanged", () => {
  const t = freshTranslator();
  t.applyLookDelta(2.0);
  const facing = t.facing;

  t.pressKey("KeyS");
  const d = t.buildDatagram(1, 1);

  assertAlmostEquals(d.movementX, -Math.cos(facing), 1e-9);
  assertAlmostEquals(d.movementY, -Math.sin(facing), 1e-9);
  assertAlmostEquals(t.facing, facing, 1e-12);
});

Deno.test("idle (no keys) sends zero movement without touching facing", () => {
  const t = freshTranslator();
  t.applyLookDelta(0.42);
  const facing = t.facing;
  const d = t.buildDatagram(1, 1);
  assertEquals(d.movementX, 0);
  assertEquals(d.movementY, 0);
  assertAlmostEquals(t.facing, facing, 1e-12);
});

// ---- T-337: hold-to-aim input ---------------------------------------------

Deno.test("T-337: aimWeaponActive=false — useSkill is a one-shot tap, not a held bit", () => {
  const t = freshTranslator();
  t.pressKey("KeyZ"); // "useSkill" binding
  const d1 = t.buildDatagram(1, 1);
  assertEquals(hasAction(d1.actions, ACTION_USE_SKILL), true, "the press itself is a one-shot tap");
  const d2 = t.buildDatagram(2, 2);
  assertEquals(hasAction(d2.actions, ACTION_USE_SKILL), false, "still held, but not re-armed — no aim weapon equipped");
});

Deno.test("T-337: aimWeaponActive=true — useSkill rides as a HELD bit every frame while the key stays down", () => {
  const t = freshTranslator();
  t.aimWeaponActive = true;
  t.pressKey("KeyZ");
  for (let i = 0; i < 5; i++) {
    const d = t.buildDatagram(i, i);
    assertEquals(hasAction(d.actions, ACTION_USE_SKILL), true, `still held at frame ${i}`);
  }
  t.releaseKey("KeyZ");
  const d = t.buildDatagram(10, 10);
  assertEquals(hasAction(d.actions, ACTION_USE_SKILL), false, "released");
});

Deno.test("T-337: isAiming reflects aimWeaponActive AND the held trigger", () => {
  const t = freshTranslator();
  assertEquals(t.isAiming, false, "no aim weapon equipped");
  t.aimWeaponActive = true;
  assertEquals(t.isAiming, false, "equipped but not held");
  t.pressKey("KeyZ");
  assertEquals(t.isAiming, true);
  t.releaseKey("KeyZ");
  assertEquals(t.isAiming, false);
});

Deno.test("T-337: applyAimPitchDelta accumulates and clamps to the configured band; mouse-up increases pitch", () => {
  const t = freshTranslator();
  t.configure({ mouseSensitivity: 1, aim: { pitchMinDeg: 0, pitchMaxDeg: 45 } });
  assertAlmostEquals(t.aimPitch, 0, 1e-12);

  // Mouse UP (negative DOM movementY) = "up = farther" = pitch increases.
  t.applyAimPitchDelta(-0.1);
  assertAlmostEquals(t.aimPitch, 0.1, 1e-9);

  // Clamps at the upper band (45deg in radians).
  t.applyAimPitchDelta(-1000);
  assertAlmostEquals(t.aimPitch, 45 * Math.PI / 180, 1e-9);

  // Mouse DOWN decreases pitch, clamped at the lower band (0).
  t.applyAimPitchDelta(1000);
  assertAlmostEquals(t.aimPitch, 0, 1e-9);
});

Deno.test("T-337: buildDatagram carries the accumulated aimPitch", () => {
  const t = freshTranslator();
  t.configure({ mouseSensitivity: 1, aim: { pitchMinDeg: 0, pitchMaxDeg: 45 } });
  t.applyAimPitchDelta(-0.2);
  const d = t.buildDatagram(1, 1);
  assertAlmostEquals(d.pitch, 0.2, 1e-9);
});
