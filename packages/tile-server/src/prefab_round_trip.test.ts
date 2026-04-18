/**
 * Round-trip property tests — the contract between schema and codec.
 *
 * Each schemaed component is exercised with a handful of representative
 * data points. The test verifies three independent invariants per point:
 *
 *   1. The original data validates against the schema. If the test case
 *      itself doesn't match the schema, the test is ill-formed — catching
 *      that up front means schema mistakes don't slip past as codec bugs.
 *   2. Encoding then decoding the data round-trips (`deep-equal`). The
 *      codec faithfully preserves the shape.
 *   3. The decoded data also validates against the schema. The codec's
 *      output is not permitted to drift away from the shape the schema
 *      declares.
 *
 * When schemas and codecs agree on a component, point (3) is redundant
 * with (1) + (2). That redundancy is the point: if any of the three
 * invariants ever fails, the drift surface is visible in CI.
 *
 * Run: `deno test packages/tile-server/src/prefab_round_trip.test.ts`
 */
import { assertEquals } from "jsr:@std/assert";
import * as v from "valibot";
import type { ComponentDef } from "@voxim/engine";
import {
  Health, Hunger, Thirst, Stamina, CombatState,
} from "./components/game.ts";

function roundTrip<T>(def: ComponentDef<T>, cases: T[], label: string): void {
  if (!def.schema) throw new Error(`${label}: component has no schema`);
  for (const [idx, original] of cases.entries()) {
    // 1. Input validates — catches ill-formed test cases, not codec bugs.
    if (!v.is(def.schema, original)) {
      throw new Error(`${label}[${idx}]: input does not validate against schema`);
    }
    // 2. Round-trip preserves shape.
    const bytes = def.codec.encode(original);
    const decoded = def.codec.decode(bytes);
    assertEquals(decoded, original, `${label}[${idx}]: codec round-trip failed`);
    // 3. Decoded output still validates — catches codec drift from schema.
    if (!v.is(def.schema, decoded)) {
      throw new Error(`${label}[${idx}]: decoded value does not validate against schema`);
    }
  }
}

Deno.test("Health — schema/codec agreement", () => {
  roundTrip(Health, [
    { current: 100, max: 100 },
    { current: 0, max: 100 },
    { current: 37.5, max: 42.25 },
    { current: 1, max: 1 },
  ], "Health");
});

Deno.test("Hunger — schema/codec agreement", () => {
  roundTrip(Hunger, [
    { value: 0 },
    { value: 50 },
    { value: 99.5 },
  ], "Hunger");
});

Deno.test("Thirst — schema/codec agreement", () => {
  roundTrip(Thirst, [
    { value: 0 },
    { value: 50 },
    { value: 100 },
  ], "Thirst");
});

Deno.test("Stamina — schema/codec agreement", () => {
  roundTrip(Stamina, [
    { current: 100, max: 100, regenPerSecond: 8, exhausted: false },
    { current: 0,   max: 100, regenPerSecond: 8, exhausted: true  },
    { current: 42.25, max: 200, regenPerSecond: 12.5, exhausted: false },
  ], "Stamina");
});

Deno.test("CombatState — schema/codec agreement", () => {
  roundTrip(CombatState, [
    { blockHeldTicks: 0, staggerTicksRemaining: 0, counterReady: false, iFrameTicksRemaining: 0, dodgeCooldownTicks: 0 },
    { blockHeldTicks: 5, staggerTicksRemaining: 20, counterReady: true, iFrameTicksRemaining: 8, dodgeCooldownTicks: 30 },
    { blockHeldTicks: 1, staggerTicksRemaining: 0, counterReady: false, iFrameTicksRemaining: 0, dodgeCooldownTicks: 15 },
  ], "CombatState");
});

Deno.test("component registry — every registered name resolves and every def is unique", async () => {
  const { ALL_DEFS, DEF_BY_NAME } = await import("./component_registry.ts");
  assertEquals(DEF_BY_NAME.size, ALL_DEFS.length, "DEF_BY_NAME size must match ALL_DEFS");
  for (const def of ALL_DEFS) {
    assertEquals(DEF_BY_NAME.get(def.name), def, `name lookup mismatch for "${def.name}"`);
  }
});

Deno.test("schema rejects malformed data", () => {
  // A few adversarial inputs to confirm schemas actually validate.
  if (!Health.schema) throw new Error("Health.schema missing");
  if (v.is(Health.schema, { current: "lots", max: 100 })) {
    throw new Error("Health schema should reject non-number current");
  }
  if (v.is(Health.schema, { current: 100 })) {
    throw new Error("Health schema should reject missing max");
  }
  if (!Stamina.schema) throw new Error("Stamina.schema missing");
  if (v.is(Stamina.schema, { current: 100, max: 100, regenPerSecond: 8, exhausted: "yes" })) {
    throw new Error("Stamina schema should reject non-boolean exhausted");
  }
});
