/**
 * T-206 validation tests for POI definitions.
 *
 * The three checked-in example POIs in `packages/content/data/pois/` are the
 * canonical "shapes designers will author"; the schema parser should accept
 * all three. A deliberately broken POI for each of the validation rules in
 * SCHEMA.md should reject with a useful error message.
 */

import { assertEquals, assertThrows } from "jsr:@std/assert";
import { parsePoiDef } from "./poi_schema.ts";
import { JsonSource } from "./loader.ts";

// ---- the three living example POIs ----

Deno.test("parsePoiDef: wolf_den (encounter, open gate, entry-eligible)", async () => {
  const raw = JSON.parse(await Deno.readTextFile(
    new URL("../data/pois/wolf_den.json", import.meta.url).pathname,
  ));
  const poi = parsePoiDef(raw);
  assertEquals(poi.id, "wolf_den");
  assertEquals(poi.type, "encounter");
  assertEquals(poi.gate.kind, "open");
  // Type narrowing through the discriminated union.
  if (poi.type === "encounter") {
    assertEquals(poi.activity.spawnTable, "wolf_pack_medium");
  }
});

Deno.test("parsePoiDef: ancient_arena (bossfight, multi gate, terminal-only)", async () => {
  const raw = JSON.parse(await Deno.readTextFile(
    new URL("../data/pois/ancient_arena.json", import.meta.url).pathname,
  ));
  const poi = parsePoiDef(raw);
  assertEquals(poi.id, "ancient_arena");
  assertEquals(poi.type, "bossfight");
  assertEquals(poi.gate.kind, "multi");
  if (poi.gate.kind === "multi") {
    assertEquals(poi.gate.count, 2);
  }
  assertEquals(poi.roles, ["terminal"]);
});

Deno.test("parsePoiDef: glyph_puzzle (puzzle, item gate, mid+optional)", async () => {
  const raw = JSON.parse(await Deno.readTextFile(
    new URL("../data/pois/glyph_puzzle.json", import.meta.url).pathname,
  ));
  const poi = parsePoiDef(raw);
  assertEquals(poi.id, "glyph_puzzle");
  assertEquals(poi.type, "puzzle");
  assertEquals(poi.gate.kind, "item");
  if (poi.gate.kind === "item") {
    assertEquals(poi.gate.trinketRef, null);
  }
});

// ---- rejection tests for the validation rules in SCHEMA.md ----

function baseValidEncounter() {
  return JSON.parse(JSON.stringify({
    id: "test_poi",
    schema: 1,
    displayName: "Test POI",
    type: "encounter",
    activity: {
      spawnTable: "x", spawnTriggerRadius: 5, minClearKills: "all", regenAfterTicks: null,
    },
    fit: { preferredTopology: ["pocket"], minArea: 100, maxArea: 500 },
    gate: { kind: "open" },
    reward: { trinketTheme: { themes: ["x"], flavorTags: [] }, extras: [] },
    tags: [],
    difficulty: 2,
    quotaWeight: 1.0,
    roles: ["entry"],
  }));
}

Deno.test("parsePoiDef rejects unknown POI type", () => {
  const raw = baseValidEncounter();
  raw.type = "monolith";
  assertThrows(() => parsePoiDef(raw), Error, "test_poi");
});

Deno.test("parsePoiDef rejects mismatched activity for the declared type", () => {
  const raw = baseValidEncounter();
  // Type is encounter; supply a puzzle-shaped activity instead.
  raw.activity = { puzzleId: "x", params: {}, failurePenalty: "reset" };
  assertThrows(() => parsePoiDef(raw), Error, "activity mismatch");
});

Deno.test("parsePoiDef rejects unknown gate kind", () => {
  const raw = baseValidEncounter();
  raw.gate = { kind: "biometric", flavorAccept: ["bone"] };
  assertThrows(() => parsePoiDef(raw), Error);
});

Deno.test("parsePoiDef rejects difficulty out of [1,5]", () => {
  const raw = baseValidEncounter();
  raw.difficulty = 7;
  assertThrows(() => parsePoiDef(raw), Error, "difficulty");
});

Deno.test("parsePoiDef rejects schema version != 1", () => {
  const raw = baseValidEncounter();
  raw.schema = 2;
  assertThrows(() => parsePoiDef(raw), Error);
});

Deno.test("parsePoiDef rejects gate.item with non-null trinketRef (author-time binding)", () => {
  const raw = baseValidEncounter();
  raw.gate = { kind: "item", trinketRef: "preauthored", flavorAccept: ["bone"] };
  assertThrows(() => parsePoiDef(raw), Error);
});

Deno.test("parsePoiDef rejects multi gate with count < 2", () => {
  const raw = baseValidEncounter();
  raw.gate = { kind: "multi", count: 1, flavorAccept: ["bone"] };
  assertThrows(() => parsePoiDef(raw), Error);
});

Deno.test("parsePoiDef rejects empty themes array (would break trinket-naming)", () => {
  const raw = baseValidEncounter();
  raw.reward.trinketTheme.themes = [];
  assertThrows(() => parsePoiDef(raw), Error);
});

Deno.test("parsePoiDef rejects unknown role", () => {
  const raw = baseValidEncounter();
  raw.roles = ["entry", "boss"]; // "boss" is not a PoiRole
  assertThrows(() => parsePoiDef(raw), Error);
});

// ---- integration: loader picks up POIs and ContentService can query them ----

Deno.test("JsonSource.load: pois registry contains the authored roster", async () => {
  const content = await JsonSource.load();
  // The roster grows over time (T-207 expanded it from 3 → 15). Assert the
  // three foundational examples are present and the registry is non-empty.
  assertEquals(content.pois.size >= 3, true);
  assertEquals(content.pois.getOrThrow("wolf_den").displayName,       "Wolf Den");
  assertEquals(content.pois.getOrThrow("ancient_arena").displayName,  "Ancient Arena");
  assertEquals(content.pois.getOrThrow("glyph_puzzle").displayName,   "Glyph Shrine");
});

Deno.test("ContentService.findPoisByRole returns POIs by their declared roles", async () => {
  const c = await JsonSource.load();
  const entry = c.findPoisByRole("entry").map(p => p.id);
  assertEquals(entry.includes("wolf_den"), true, "wolf_den should be in entry roster");
  const terminal = c.findPoisByRole("terminal").map(p => p.id);
  assertEquals(terminal.includes("ancient_arena"), true, "ancient_arena should be terminal");
  const mid = c.findPoisByRole("midchain").map(p => p.id);
  assertEquals(mid.includes("wolf_den"),     true);
  assertEquals(mid.includes("glyph_puzzle"), true);
});

Deno.test("ContentService.findPoisByTag intersects on tag value", async () => {
  const c = await JsonSource.load();
  // wolf_den is the canonical "bone" dropper.
  assertEquals(c.findPoisByTag("bone").map(p => p.id).includes("wolf_den"), true);
  // "ancient" is widely shared across the roster.
  const ancientIds = c.findPoisByTag("ancient").map(p => p.id);
  assertEquals(ancientIds.includes("ancient_arena"), true);
  assertEquals(ancientIds.includes("glyph_puzzle"),  true);
  assertEquals(c.findPoisByTag("nonexistent_tag").length, 0);
});
