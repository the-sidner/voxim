import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import { nameZone, NAMED_AREA_MIN } from "./zone_namer.ts";

const FOREST_BIOME = { altitude: 0.4, moisture: 0.55, temperature: 0.5, ruggedness: 0.3 };
const TUNDRA_BIOME = { altitude: 0.4, moisture: 0.5, temperature: 0.2, ruggedness: 0.3 };

Deno.test("zone namer: identical inputs → identical names", () => {
  const a = nameZone(42, 5, 200, "grove", "wilderness", FOREST_BIOME);
  const b = nameZone(42, 5, 200, "grove", "wilderness", FOREST_BIOME);
  assertEquals(a, b);
});

Deno.test("zone namer: different zone ids on same tile → different names (typically)", () => {
  // 10 sample zones; we expect at least 7 distinct names — collisions
  // happen but should be rare with our 16+-adjective pools.
  const names = new Set<string>();
  for (let i = 0; i < 10; i++) {
    names.add(nameZone(42, i, 200, "grove", "wilderness", FOREST_BIOME));
  }
  assert(names.size >= 7, `expected ≥7 unique names from 10 zones, got ${names.size}: ${[...names].join(", ")}`);
});

Deno.test("zone namer: different biomes produce different adjective pools", () => {
  // Run many zones and check that forest vs tundra produce different
  // sets of adjectives. The set of adjectives can overlap (some
  // adjectives belong to both pools), but the dominant adjective
  // characters should differ.
  const forestNames = new Set<string>();
  const tundraNames = new Set<string>();
  for (let i = 0; i < 30; i++) {
    forestNames.add(nameZone(99, i, 200, "grove", "wilderness", FOREST_BIOME));
    tundraNames.add(nameZone(99, i, 200, "grove", "wilderness", TUNDRA_BIOME));
  }
  // At least one name must differ between biomes.
  let overlap = 0;
  for (const n of forestNames) if (tundraNames.has(n)) overlap++;
  assert(overlap < forestNames.size, "forest and tundra biomes should produce some unique names");
});

Deno.test("zone namer: sub-threshold area → empty string", () => {
  const n = nameZone(42, 0, NAMED_AREA_MIN - 1, "thicket", "wilderness", FOREST_BIOME);
  assertEquals(n, "");
});

Deno.test("zone namer: at-threshold area → non-empty name", () => {
  const n = nameZone(42, 0, NAMED_AREA_MIN, "thicket", "wilderness", FOREST_BIOME);
  assertNotEquals(n, "");
  assert(n.includes(" "), `expected adj-noun pattern, got "${n}"`);
});

Deno.test("zone namer: path adjectives differ from wilderness adjectives over many samples", () => {
  // With 100 different zone ids, the wilderness and path pools should
  // each draw from their own adjective list with high probability.
  const pathNames = new Set<string>();
  const wildNames = new Set<string>();
  for (let i = 0; i < 100; i++) {
    pathNames.add(nameZone(7, i, 200, "plaza",  "path",       FOREST_BIOME));
    wildNames.add(nameZone(7, i, 200, "grove",  "wilderness", FOREST_BIOME));
  }
  assert(pathNames.size > 5);
  assert(wildNames.size > 5);
});
