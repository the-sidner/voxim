/**
 * Flicker-curve registry + boot cross-check (T-311 Phase 2). Runs headless (no
 * THREE/DOM). Pins: built-in registration is idempotent and covers the curves the
 * authored LightDefs reference, 'steady' is identity, 'torch' oscillates around
 * the base, the cross-check resolves real content, and it fails fast on a typo.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { JsonSource } from "@voxim/content";
import {
  registerBuiltinFlickerCurves,
  getFlickerCurve,
  flickerCurveIds,
  crossCheckFlickerCurves,
} from "./flicker_curves.ts";

const content = await JsonSource.load("packages/content/data");

Deno.test("T-311: built-in flicker curves register (idempotent) and cover steady/torch/candle", () => {
  registerBuiltinFlickerCurves();
  registerBuiltinFlickerCurves(); // no-op, not a double-register throw
  for (const id of ["steady", "torch", "candle"]) {
    assert(flickerCurveIds().includes(id), `curve "${id}" registered`);
  }
});

Deno.test("T-311: steady is identity; torch oscillates around the base", () => {
  assertEquals(getFlickerCurve("steady")!(1.23, 0.5, 2.0), 2.0);
  // torch never collapses below the 0.1× floor and stays near the base
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < 200; i++) {
    const v = getFlickerCurve("torch")!(i * 0.05, 0.7, 1.0);
    min = Math.min(min, v); max = Math.max(max, v);
  }
  assert(min >= 0.1, `torch floor respected (min=${min})`);
  assert(max > 1.0 && max < 1.3, `torch swings above base modestly (max=${max})`);
});

Deno.test("T-311: crossCheckFlickerCurves passes on the real content", () => {
  crossCheckFlickerCurves(content); // throws on a typo — reaching here is the pass
});

Deno.test("T-311: cross-check throws on an unknown flickerCurveId", () => {
  const bad = {
    lights: { values: () => [{ id: "broken", flickerCurveId: "no_such_curve" }] },
  } as unknown as Parameters<typeof crossCheckFlickerCurves>[0];
  let threw = false;
  try { crossCheckFlickerCurves(bad); } catch { threw = true; }
  assert(threw, "unknown flickerCurveId rejected");
});
