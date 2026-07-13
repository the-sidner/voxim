/**
 * facingFromLook is the T-328 mouse-driven facing rule: facing accumulates
 * from raw look-delta pixels (dx*sensitivity), wrapped into (-π, π]. Pure →
 * deterministic. The dense-sweep continuity test is T-324's regression pin,
 * relocated here — wrap ownership moved from camera_rig.ts's yaw to this
 * accumulator (T-328 inverts which axis owns the mouse-X integration).
 */
import { assert, assertAlmostEquals } from "jsr:@std/assert";
import { facingFromLook } from "./facing.ts";

Deno.test("accumulates facing by dx*sensitivity", () => {
  const f0 = facingFromLook(0, 100, 0.0022);
  assertAlmostEquals(f0, 100 * 0.0022, 1e-12);
  const f1 = facingFromLook(f0, 50, 0.0022);
  assertAlmostEquals(f1, 150 * 0.0022, 1e-12);
});

Deno.test("negative dx rotates facing the other way", () => {
  assertAlmostEquals(facingFromLook(0, -100, 0.0022), -100 * 0.0022, 1e-12);
});

Deno.test("zero dx holds facing exactly (no drift from a still mouse)", () => {
  assertAlmostEquals(facingFromLook(1.234, 0, 0.0022), 1.234, 1e-12);
});

Deno.test("wraps into (-π, π]", () => {
  const sensitivity = 0.0022;
  const pixelsForOneTurn = (2 * Math.PI) / sensitivity;
  const f = facingFromLook(0, pixelsForOneTurn * 1.25, sensitivity);
  assert(f > -Math.PI && f <= Math.PI, `facing ${f} not wrapped`);
});

Deno.test("T-324: dense 360°+ sweep is continuous (no snap)", () => {
  // Regression pin for the user-reported "~90° snap at a certain rotation"
  // (live play 2026-07-07), relocated from camera_rig.ts's applyLookDelta
  // sweep test now that mouse-X accumulation lives here (T-328).
  const sensitivity = 0.0022;
  for (const dxPerEvent of [1, 5, -5, 37, -200]) {
    const stepRad = dxPerEvent * sensitivity;
    const pixelsForOneTurn = (2 * Math.PI) / sensitivity;
    const steps = Math.ceil((5 * pixelsForOneTurn) / Math.abs(dxPerEvent));
    let f = 0;
    for (let i = 0; i < steps; i++) {
      const next = facingFromLook(f, dxPerEvent, sensitivity);
      let d = next - f;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      assertAlmostEquals(
        d,
        stepRad,
        1e-9,
        `discontinuity at facing=${next.toFixed(6)} (${(next * 180 / Math.PI).toFixed(2)}°), step ${i}, dx=${dxPerEvent}`,
      );
      f = next;
    }
  }
});
