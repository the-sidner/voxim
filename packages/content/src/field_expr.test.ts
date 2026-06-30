/**
 * FieldExpr evaluator + vocabulary cross-check (T-311 G2). Pure, headless.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { evaluateFieldExpr, crossCheckFieldExpr, type FieldExpr } from "./field_expr.ts";

const sample = (vals: Record<string, number>) => (f: string) => vals[f] ?? 0;

Deno.test("T-311: empty expr → 0; linear remap windows on min/max", () => {
  assertEquals(evaluateFieldExpr([], () => 1), 0);
  const e: FieldExpr = [{ field: "fertility", curve: "linear", min: 0, max: 1, weight: 1 }];
  assertEquals(evaluateFieldExpr(e, sample({ fertility: 0.5 })), 0.5);
  // window [0.2,0.8]: 0.2→0, 0.8→1, 0.5→0.5
  const w: FieldExpr = [{ field: "fertility", curve: "linear", min: 0.2, max: 0.8, weight: 1 }];
  assertEquals(evaluateFieldExpr(w, sample({ fertility: 0.2 })), 0);
  assertEquals(evaluateFieldExpr(w, sample({ fertility: 0.8 })), 1);
  assertEquals(Math.abs(evaluateFieldExpr(w, sample({ fertility: 0.5 })) - 0.5) < 1e-6, true);
});

Deno.test("T-311: step + smoothstep curves", () => {
  const step: FieldExpr = [{ field: "corruption", curve: "step", min: 0, max: 1, weight: 1 }];
  assertEquals(evaluateFieldExpr(step, sample({ corruption: 0.49 })), 0);
  assertEquals(evaluateFieldExpr(step, sample({ corruption: 0.5 })), 1);
  const ss: FieldExpr = [{ field: "corruption", curve: "smoothstep", min: 0, max: 1, weight: 1 }];
  assertEquals(evaluateFieldExpr(ss, sample({ corruption: 0.5 })), 0.5);  // smoothstep(0.5)=0.5
  assert(evaluateFieldExpr(ss, sample({ corruption: 0.25 })) < 0.25);     // eased in
});

Deno.test("T-311: terms sum then clamp to [0,1]", () => {
  const e: FieldExpr = [
    { field: "fertility", curve: "linear", min: 0, max: 1, weight: 0.7 },
    { field: "wetness",   curve: "linear", min: 0, max: 1, weight: 0.7 },
  ];
  // 0.7×1 + 0.7×1 = 1.4 → clamped 1
  assertEquals(evaluateFieldExpr(e, sample({ fertility: 1, wetness: 1 })), 1);
  // 0.7×0.5 + 0.7×0 = 0.35
  assert(Math.abs(evaluateFieldExpr(e, sample({ fertility: 0.5, wetness: 0 })) - 0.35) < 1e-6);
});

Deno.test("T-311: cross-check passes known fields, throws on a typo", () => {
  crossCheckFieldExpr([{ field: "canopyLight", curve: "linear", min: 0, max: 1, weight: 1 }], "test");
  let threw = false;
  try {
    crossCheckFieldExpr([{ field: "sunlight", curve: "linear", min: 0, max: 1, weight: 1 }], "test");
  } catch { threw = true; }
  assert(threw, "unknown field rejected");
});
