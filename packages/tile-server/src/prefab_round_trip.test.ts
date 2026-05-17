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
  Health,
} from "./components/game.ts";
import {
  Armor,
  Composed,
  Deployable,
  Placeable,
  Equippable,
  Illuminator,
  MaterialSource,
  Stackable,
  Swingable,
  Tool,
  Weight,
} from "./components/item_behaviours.ts";

function roundTrip<T>(def: ComponentDef<T>, cases: T[], label: string): void {
  if (!def.schema) throw new Error(`${label}: component has no schema`);
  for (const [idx, original] of cases.entries()) {
    // 1. Input validates — catches ill-formed test cases, not codec bugs.
    if (!v.is(def.schema, original)) {
      throw new Error(
        `${label}[${idx}]: input does not validate against schema`,
      );
    }
    // 2. Round-trip preserves shape.
    const bytes = def.codec.encode(original);
    const decoded = def.codec.decode(bytes);
    assertEquals(
      decoded,
      original,
      `${label}[${idx}]: codec round-trip failed`,
    );
    // 3. Decoded output still validates — catches codec drift from schema.
    if (!v.is(def.schema, decoded)) {
      throw new Error(
        `${label}[${idx}]: decoded value does not validate against schema`,
      );
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



Deno.test("Equippable — schema/codec agreement", () => {
  roundTrip(Equippable, [
    { slot: "weapon" },
    { slot: "head" },
    { slot: "back" },
    { slot: "offHand" },
  ], "Equippable");
});

Deno.test("Swingable — schema/codec agreement", () => {
  // The codec always writes both chargeMin/chargeMax; on decode they come
  // back as concrete numbers. Author canonical (already-defaulted) shapes
  // here so the round-trip equality holds.
  // Codec round-trips { chain, heavyChargeMs, damage? }. `swingActionId`
  // is not on the wire (server-only authoring field), so it isn't part of
  // the round-trip shapes here.
  roundTrip(Swingable, [
    { chain: [{ light: "swing_light", heavy: "swing_heavy" }], heavyChargeMs: 250 },
    { chain: [{ light: "swing_thrust", heavy: "swing_heavy" }], heavyChargeMs: 250 },
    { chain: [
      { light: "swing_light",  heavy: "swing_heavy" },
      { light: "swing_medium", heavy: "swing_spin"  },
    ], heavyChargeMs: 300 },
    // damage: present round-trips as a number
    { chain: [{ light: "swing_light", heavy: "swing_heavy" }], heavyChargeMs: 250, damage: 12 },
    // damage: absent round-trips as absent (undefined ≠ explicit 0)
    { chain: [{ light: "swing_light", heavy: "swing_heavy" }], heavyChargeMs: 250 },
  ], "Swingable");
});

Deno.test("Tool — schema/codec agreement", () => {
  roundTrip(Tool, [
    { toolType: "axe" },
    { toolType: "hammer" },
    { toolType: "" },
  ], "Tool");
});

Deno.test("Deployable — schema/codec agreement", () => {
  roundTrip(Deployable, [
    { prefabId: "campfire" },
    { prefabId: "chair_entity" },
    { prefabId: "" },
  ], "Deployable");
});

Deno.test("Placeable — schema/codec agreement", () => {
  roundTrip(Placeable, [
    { alignment: "forward-facing" },
    { alignment: "cell-aligned", requiresToolType: "hammer", cellMustBeEmpty: true },
    { alignment: "forward-facing", reach: 3.5 },
    { alignment: "cell-aligned", requiresToolType: "hammer", reach: 2.0, cellMustBeEmpty: true },
  ], "Placeable");
});

Deno.test("Illuminator — schema/codec agreement", () => {
  // Floats are f32 — use dyadic rationals so round-trip is exact.
  roundTrip(Illuminator, [
    { radius: 8, color: 0xffaa44, intensity: 1, flicker: 0.125 },
    { radius: 0, color: 0, intensity: 0, flicker: 0 },
    { radius: 12.5, color: 0xffffff, intensity: 0.75, flicker: 0.25 },
  ], "Illuminator");
});

Deno.test("Armor — schema/codec agreement", () => {
  roundTrip(Armor, [
    { reduction: 0, staminaPenalty: 0 },
    { reduction: 0.25, staminaPenalty: 0.125 },
    { reduction: 0.75, staminaPenalty: 0.5 },
  ], "Armor");
});

Deno.test("MaterialSource — schema/codec agreement", () => {
  roundTrip(MaterialSource, [
    { materialName: "iron" },
    { materialName: "oak" },
    { materialName: "" },
  ], "MaterialSource");
});

Deno.test("Composed — schema/codec agreement", () => {
  roundTrip(Composed, [
    { slots: [] },
    {
      slots: [
        {
          id: "blade",
          materialCategories: ["metal"],
          statContributions: [
            { stat: "damage", property: "hardness", multiplier: 10 },
            { stat: "weight", property: "density", multiplier: 0.5 },
          ],
          modelSlotId: "blade",
        },
        {
          id: "grip",
          materialCategories: ["wood", "bone", "leather"],
          statContributions: [
            { stat: "weight", property: "density", multiplier: 0.25 },
          ],
        },
      ],
    },
  ], "Composed");
});

Deno.test("Stackable — schema/codec agreement", () => {
  roundTrip(Stackable, [
    {},
  ], "Stackable");
});

Deno.test("Weight — schema/codec agreement", () => {
  roundTrip(Weight, [
    { baseWeight: 0 },
    { baseWeight: 1.5 },
    { baseWeight: 42.25 },
  ], "Weight");
});

Deno.test("component registry — every registered name resolves and every def is unique", async () => {
  const { ALL_DEFS, DEF_BY_NAME } = await import("./component_registry.ts");
  assertEquals(
    DEF_BY_NAME.size,
    ALL_DEFS.length,
    "DEF_BY_NAME size must match ALL_DEFS",
  );
  for (const def of ALL_DEFS) {
    assertEquals(
      DEF_BY_NAME.get(def.name),
      def,
      `name lookup mismatch for "${def.name}"`,
    );
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
});
