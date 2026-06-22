/**
 * Cave instance tile type (T-063).
 *
 * v1 scope: a cave tile id is PARSEABLE and the cave tile TYPE is
 * GENERABLE from the forced `cave` biome. The live stair→instance→exit
 * loop is T-212 and not exercised here.
 *
 * Covered:
 *   - parseTileId discriminates overworld `cellX_cellY` from the cave
 *     instance form `cave_<x>_<y>_<level>`.
 *   - the `cave` biome loads from real content, is instanceOnly, and is
 *     rock-dominant (stone fallback, no grass/sand/water).
 *   - classifyBiome never returns the instance-only cave biome — it can't
 *     hijack the overworld cascade.
 *   - caveInstanceTerrain forces the cave biome: the generated tile is
 *     stone-dominant, contains no grass, and its seed is stable per id.
 */

import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { JsonSource } from "@voxim/content";
import { classifyBiome } from "@voxim/world";
import { parseTileId, caveInstanceTerrain } from "./atlas_terrain.ts";

Deno.test("parseTileId: overworld cellX_cellY form", () => {
  assertEquals(parseTileId("0_0"), { kind: "overworld", cellX: 0, cellY: 0 });
  assertEquals(parseTileId("2_3"), { kind: "overworld", cellX: 2, cellY: 3 });
});

Deno.test("parseTileId: cave instance form", () => {
  assertEquals(parseTileId("cave_2_3_0"), {
    kind: "instance", instanceType: "cave", cellX: 2, cellY: 3, level: 0,
  });
  assertEquals(parseTileId("cave_10_4_2"), {
    kind: "instance", instanceType: "cave", cellX: 10, cellY: 4, level: 2,
  });
});

Deno.test("parseTileId: rejects malformed ids", () => {
  assertThrows(() => parseTileId("nonsense"));
  assertThrows(() => parseTileId("cave_2_3"));     // missing level
  assertThrows(() => parseTileId("cave_x_y_z"));   // non-numeric
});

Deno.test("cave biome loads and is rock-dominant + instanceOnly", async () => {
  const content = await JsonSource.load();
  const cave = content.biomes.getOrThrow("cave");

  assertEquals(cave.instanceOnly, true);
  // Fallback material rule (no conditions) is the rock body of the cave.
  const fallback = cave.materialRules[cave.materialRules.length - 1];
  assertEquals(fallback.materialName, "stone");
  // No open-air materials anywhere in the cascade.
  const names = cave.materialRules.map((r) => r.materialName);
  for (const banned of ["grass", "sand", "water"]) {
    assert(!names.includes(banned), `cave biome should not use "${banned}"`);
  }
});

Deno.test("classifyBiome never returns the instance-only cave biome", async () => {
  const content = await JsonSource.load();
  const all = content.getBiomesByPriority();
  // Sweep a coarse grid of the classification space — cave must never win.
  for (let t = 0; t <= 1; t += 0.25) {
    for (let m = 0; m <= 1; m += 0.25) {
      for (let a = 0; a <= 1; a += 0.25) {
        const picked = classifyBiome(all, {
          temperature: t, moisture: m, normalizedAltitude: a,
        });
        assert(picked.id !== "cave", `cave won at t=${t} m=${m} a=${a}`);
      }
    }
  }
});

Deno.test("caveInstanceTerrain forces cave biome: stone-dominant, no grass, stable seed", async () => {
  const content = await JsonSource.load();
  const stoneId = content.materials.getOrThrow("stone").id;
  const grassId = content.materials.getOrThrow("grass").id;

  const result = await caveInstanceTerrain("cave_2_3_0", content);

  // Seed is derived from the tile id (stable per stair).
  const again = await caveInstanceTerrain("cave_2_3_0", content);
  assertEquals(result.tileSeed, again.tileSeed);
  assertEquals(result.cellX, 2);
  assertEquals(result.cellY, 3);
  assertEquals(result.level, 0);

  // Material tally — stone must dominate; grass (an overworld-only
  // material) must be absent because the cave biome was forced.
  let stone = 0;
  let grass = 0;
  for (let i = 0; i < result.materialBuffer.length; i++) {
    const m = result.materialBuffer[i];
    if (m === stoneId) stone++;
    else if (m === grassId) grass++;
  }
  assertEquals(grass, 0, "forced cave biome must produce no grass");
  assert(
    stone > result.materialBuffer.length * 0.5,
    `cave should be stone-dominant, got ${stone}/${result.materialBuffer.length}`,
  );

  // Buffers are full-resolution and self-consistent.
  assertEquals(result.heightBuffer.length, result.materialBuffer.length);
});

Deno.test("caveInstanceTerrain rejects an overworld tile id", async () => {
  const content = await JsonSource.load();
  await assertRejects(() => caveInstanceTerrain("0_0", content));
});
