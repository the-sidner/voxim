/**
 * water_renderer.buildWaterGeo — pure geometry from a synthetic
 * WaterGrid.surfaceLevel buffer (T-311 P5b). No THREE scene/material
 * dependency; headless.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { buildWaterGeo } from "./water_renderer.ts";
import { CHUNK_SIZE } from "@voxim/world";

function emptyChunk(): Float32Array {
  return new Float32Array(CHUNK_SIZE * CHUNK_SIZE).fill(NaN);
}

Deno.test("T-311 P5b: an all-dry chunk (all NaN) produces no geometry", () => {
  const geo = buildWaterGeo(0, 0, emptyChunk());
  assertEquals(geo, null);
});

Deno.test("T-311 P5b: a single water cell produces one quad at its surfaceLevel", () => {
  const surface = emptyChunk();
  surface[5 + 5 * CHUNK_SIZE] = 12.5;
  const geo = buildWaterGeo(0, 0, surface);
  assert(geo !== null);
  const pos = geo!.getAttribute("position");
  assertEquals(pos.count, 4); // one quad = 4 verts
  // All 4 verts share the surface height.
  for (let i = 0; i < 4; i++) assertEquals(pos.getY(i), 12.5);
});

Deno.test("T-311 P5b: a contiguous same-height row run merges into ONE quad, not N", () => {
  const surface = emptyChunk();
  for (let lx = 0; lx < 10; lx++) surface[lx + 3 * CHUNK_SIZE] = 8.0;
  const geo = buildWaterGeo(0, 0, surface);
  assert(geo !== null);
  // A merged run is still one quad (4 verts), spanning the full run width —
  // not 10 separate quads (40 verts).
  assertEquals(geo!.getAttribute("position").count, 4);
});

Deno.test("T-311 P5b: a same-row run with DIFFERING heights splits into separate quads", () => {
  const surface = emptyChunk();
  surface[0 + 4 * CHUNK_SIZE] = 5.0;
  surface[1 + 4 * CHUNK_SIZE] = 5.0;
  surface[2 + 4 * CHUNK_SIZE] = 6.0; // different height — must NOT merge with the run above
  const geo = buildWaterGeo(0, 0, surface);
  assert(geo !== null);
  // Two runs: [0,2) at height 5.0, [2,3) at height 6.0 — 2 quads = 8 verts.
  assertEquals(geo!.getAttribute("position").count, 8);
});

Deno.test("T-311 P5b: chunk offset threads through to world-space vertex positions", () => {
  const surface = emptyChunk();
  surface[0] = 3.0; // local (0,0)
  const geo = buildWaterGeo(2, 1, surface); // chunk (2,1)
  assert(geo !== null);
  const pos = geo!.getAttribute("position");
  const offX = 2 * CHUNK_SIZE;
  const offZ = 1 * CHUNK_SIZE;
  // First vertex of the quad is at the cell's world-space min corner.
  assertEquals(pos.getX(0), offX);
  assertEquals(pos.getZ(0), offZ);
});
