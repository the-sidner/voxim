/**
 * Terrain lookup probes — pins the numeric-key/inlined-math probe (T-361)
 * against the reference coordinate helpers (worldToChunk/worldToLocal):
 * same heights and openness across chunk borders, fractional coordinates,
 * and out-of-tile queries.
 */
import { assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { Heightmap, OpenMask, CHUNK_SIZE, worldToChunk, worldToLocal, getHeight } from "@voxim/world";
import type { HeightmapData } from "@voxim/world";
import { buildTerrainLookup, buildOpennessLookup } from "./terrain_lookup.ts";

/** Height fingerprint that varies per chunk AND per cell. */
function cellHeight(chunkX: number, chunkY: number, lx: number, ly: number): number {
  return chunkX * 100 + chunkY * 10 + lx + ly / 100;
}

function setup(): World {
  const world = new World();
  for (const [chunkX, chunkY] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const data = new Float32Array(CHUNK_SIZE * CHUNK_SIZE);
    const open = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        data[lx + ly * CHUNK_SIZE] = cellHeight(chunkX, chunkY, lx, ly);
        open[lx + ly * CHUNK_SIZE] = (lx + ly + chunkX) % 3 === 0 ? 0 : 1;
      }
    }
    const id = newEntityId();
    world.create(id);
    world.write(id, Heightmap, { data, chunkX, chunkY });
    world.write(id, OpenMask, { data: open });
  }
  return world;
}

const PROBES: Array<[number, number]> = [
  [0, 0], [0.99, 0.01], [31.99, 31.99],        // inside chunk (0,0)
  [32, 0], [32.5, 31.2], [0, 32], [33.7, 45.2], // across chunk borders
  [63.99, 63.99], [47.5, 47.5],                 // chunk (1,1)
];

Deno.test("buildTerrainLookup matches the reference chunk/local math", () => {
  const world = setup();
  const probe = buildTerrainLookup(world);

  // Reference: original worldToChunk/worldToLocal + string-key path.
  const ref = new Map<string, HeightmapData>();
  for (const { heightmap } of world.query(Heightmap)) {
    ref.set(`${heightmap.chunkX},${heightmap.chunkY}`, heightmap);
  }
  for (const [x, y] of PROBES) {
    const { chunkX, chunkY } = worldToChunk(x, y);
    const { localX, localY } = worldToLocal(x, y);
    const expected = getHeight(ref.get(`${chunkX},${chunkY}`)!, Math.floor(localX), Math.floor(localY));
    assertEquals(probe(x, y), expected, `height at (${x},${y})`);
    // fround: heights live in a Float32Array, so compare at f32 precision.
    assertEquals(probe(x, y), Math.fround(cellHeight(chunkX, chunkY, Math.floor(localX), Math.floor(localY))));
  }
});

Deno.test("buildTerrainLookup returns 0 for out-of-tile probes", () => {
  const probe = buildTerrainLookup(setup());
  assertEquals(probe(-1, 5), 0);
  assertEquals(probe(5, 200), 0);
});

Deno.test("buildOpennessLookup matches the reference and defaults open off-tile", () => {
  const world = setup();
  const isOpen = buildOpennessLookup(world);
  for (const [x, y] of PROBES) {
    const { chunkX, chunkY } = worldToChunk(x, y);
    const { localX, localY } = worldToLocal(x, y);
    const expected = (Math.floor(localX) + Math.floor(localY) + chunkX) % 3 !== 0;
    assertEquals(isOpen(x, y), expected, `openness at (${x},${y})`);
  }
  assertEquals(isOpen(-3, -3), true, "off-tile must not block");
});
