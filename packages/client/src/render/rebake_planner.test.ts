/**
 * RebakePlanner tests — the terrain neighbour-rebake dedupe (headless, pure
 * data; same precedent as terrain_voxels.test.ts).
 *
 * Grid convention mirrors buildChunkAtoms's neigh(): a chunk's bake consumes
 * its N neighbour's row CHUNK-1, S neighbour's row 0, E neighbour's column 0,
 * W neighbour's column CHUNK-1.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import type { HeightmapData } from "@voxim/codecs";
import { RebakePlanner, type NeighbourHeightmaps } from "./rebake_planner.ts";

const CHUNK = 32;

function hm(cx: number, cy: number, fill = 3): HeightmapData {
  return { chunkX: cx, chunkY: cy, data: new Float32Array(CHUNK * CHUNK).fill(fill) };
}

const NO_NB: NeighbourHeightmaps = { N: null, E: null, S: null, W: null };

Deno.test("load-time flush: baking chunk B after neighbour A already consumed B's current edge reports A as NOT stale", () => {
  const planner = new RebakePlanner();
  const a = hm(0, 0);
  const b = hm(1, 0); // east of a

  // A bakes with B present (the load flush merges every heightmap first).
  planner.recordBake(0, 0, { ...NO_NB, E: b });
  // B's own updateTerrain fires next in the flush: A consumed B's CURRENT
  // west column, so A must not re-bake — this is the 1280→256 dedupe.
  assertEquals(planner.staleNeighbours(1, 0, b), []);
});

Deno.test("interior dig: a heightmap change away from every border leaves all baked neighbours clean", () => {
  const planner = new RebakePlanner();
  const c = hm(1, 1);
  const north = hm(1, 0), south = hm(1, 2), east = hm(2, 1), west = hm(0, 1);
  planner.recordBake(1, 0, { ...NO_NB, S: c });
  planner.recordBake(1, 2, { ...NO_NB, N: c });
  planner.recordBake(2, 1, { ...NO_NB, W: c });
  planner.recordBake(0, 1, { ...NO_NB, E: c });
  void north; void south; void east; void west;

  c.data[5 + 5 * CHUNK] -= 1; // interior cell — touches no border row/column

  assertEquals(planner.staleNeighbours(1, 1, c), [], "interior digs must re-bake exactly one chunk");
});

Deno.test("border dig: only the neighbour sharing the changed edge goes stale", () => {
  const planner = new RebakePlanner();
  const c = hm(1, 1);
  planner.recordBake(1, 0, { ...NO_NB, S: c }); // north neighbour consumed c's row 0
  planner.recordBake(2, 1, { ...NO_NB, W: c }); // east neighbour consumed c's column CHUNK-1

  c.data[7 + 0 * CHUNK] -= 1; // dig on c's NORTH edge (row 0)

  assertEquals(planner.staleNeighbours(1, 1, c), [[1, 0]], "only the north neighbour re-bakes");
});

Deno.test("never-baked neighbours are skipped (they bake via their own updateTerrain), but a neighbour baked against the no-wall fallback is stale once the chunk streams in", () => {
  const planner = new RebakePlanner();
  const c = hm(1, 1);

  // Nothing recorded at all: no neighbour has baked → nothing to correct.
  assertEquals(planner.staleNeighbours(1, 1, c), []);

  // West neighbour baked BEFORE c existed (consumed edge null on that side).
  planner.recordBake(0, 1, NO_NB);
  assertEquals(planner.staleNeighbours(1, 1, c), [[0, 1]], "a no-wall-fallback bake must be corrected to the true cliff");

  // After the west neighbour re-bakes WITH c present, it's clean again.
  planner.recordBake(0, 1, { ...NO_NB, E: c });
  assertEquals(planner.staleNeighbours(1, 1, c), []);
});

Deno.test("forget/clear drop recorded bakes (removeTerrain / tile transition)", () => {
  const planner = new RebakePlanner();
  const c = hm(1, 1);
  planner.recordBake(1, 0, NO_NB);
  planner.recordBake(0, 1, NO_NB);
  assertEquals(planner.staleNeighbours(1, 1, c).length, 2);

  planner.forget(1, 0);
  assertEquals(planner.staleNeighbours(1, 1, c), [[0, 1]]);

  planner.clear();
  assertEquals(planner.staleNeighbours(1, 1, c), []);
});

Deno.test("recorded edges are copies — mutating the neighbour's heightmap afterwards genuinely reads as stale", () => {
  const planner = new RebakePlanner();
  const c = hm(1, 1);
  planner.recordBake(1, 0, { ...NO_NB, S: c }); // consumed a COPY of c's row 0

  c.data[0] += 2; // in-place mutation of the same Float32Array

  assert(planner.staleNeighbours(1, 1, c).length === 1, "the consumed snapshot must not alias the live heightmap");
});
