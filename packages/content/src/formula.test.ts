import { assertEquals, assertThrows } from "jsr:@std/assert";
import { parseFormula, evalFormula, checkVars } from "./formula.ts";

function evalStr(src: string, scope: Record<string, number> = {}): number {
  return evalFormula(parseFormula(src), scope);
}

Deno.test("formula: basic arithmetic", () => {
  assertEquals(evalStr("1 + 2"),         3);
  assertEquals(evalStr("3 - 4"),        -1);
  assertEquals(evalStr("2 * 3 + 4"),    10);
  assertEquals(evalStr("2 + 3 * 4"),    14);
  assertEquals(evalStr("(2 + 3) * 4"),  20);
  assertEquals(evalStr("10 / 4"),        2.5);
});

Deno.test("formula: unary minus", () => {
  assertEquals(evalStr("-5"),       -5);
  assertEquals(evalStr("-5 + 3"),   -2);
  assertEquals(evalStr("3 + -5"),   -2);
  assertEquals(evalStr("-(2 + 3)"), -5);
});

Deno.test("formula: floats", () => {
  assertEquals(evalStr("0.5 + 0.25"), 0.75);
  assertEquals(evalStr("1.5 * 2"),    3);
});

Deno.test("formula: variables (dotted identifiers)", () => {
  assertEquals(
    evalStr("stave.flexibility * 25", { "stave.flexibility": 0.8 }),
    20,
  );
  assertEquals(
    evalStr("stave.spring + skill.bowyer * 2", { "stave.spring": 5, "skill.bowyer": 3 }),
    11,
  );
});

Deno.test("formula: undefined variable fails", () => {
  assertThrows(
    () => evalStr("missing.var", {}),
    Error,
    "undefined variable 'missing.var'",
  );
});

Deno.test("formula: min/max/clamp", () => {
  assertEquals(evalStr("min(3, 1, 2)"),    1);
  assertEquals(evalStr("max(3, 1, 2)"),    3);
  assertEquals(evalStr("clamp(5, 0, 3)"),  3);
  assertEquals(evalStr("clamp(-1, 0, 3)"), 0);
  assertEquals(evalStr("clamp(2, 0, 3)"),  2);
});

Deno.test("formula: clamp arity is exactly 3", () => {
  assertThrows(() => parseFormula("clamp(1, 2)"),       Error, "'clamp' takes 3 args");
  assertThrows(() => parseFormula("clamp(1, 2, 3, 4)"), Error, "'clamp' takes 3 args");
});

Deno.test("formula: min/max require ≥2 args", () => {
  assertThrows(() => parseFormula("min(1)"), Error, "'min' takes 2");
});

Deno.test("formula: ParsedFormula.vars collects every reference", () => {
  const p = parseFormula("a.x + b.y * max(c.z, a.x)");
  assertEquals([...p.vars].sort(), ["a.x", "b.y", "c.z"]);
});

Deno.test("formula: checkVars reports missing references only", () => {
  const p = parseFormula("a.x + b.y");
  assertEquals(checkVars(p, new Set(["a.x", "b.y"])).size,             0);
  assertEquals([...checkVars(p, new Set(["a.x"]))].sort(),             ["b.y"]);
  assertEquals([...checkVars(p, new Set())].sort(),                    ["a.x", "b.y"]);
});

Deno.test("formula: syntax errors are reported", () => {
  assertThrows(() => parseFormula(""),         Error, "empty");
  assertThrows(() => parseFormula("1 +"),      Error, "unexpected end");
  assertThrows(() => parseFormula("(1 + 2"),   Error, "expected ')'");
  assertThrows(() => parseFormula("1 + + 2"),  Error);
  assertThrows(() => parseFormula("1 ! 2"),    Error, "unexpected character");
});

Deno.test("formula: realistic bow recipe expression", () => {
  // Bow draw_weight = stave.spring * 25 + skill.bowyer * 0.5,
  // clamped between 5 and 60.
  const f = parseFormula("clamp(stave.spring * 25 + skill.bowyer * 0.5, 5, 60)");
  assertEquals(evalFormula(f, { "stave.spring": 1.0, "skill.bowyer": 4 }), 27);
  assertEquals(evalFormula(f, { "stave.spring": 0.0, "skill.bowyer": 0 }),  5); // clamp lo
  assertEquals(evalFormula(f, { "stave.spring": 5.0, "skill.bowyer": 0 }), 60); // clamp hi
});
