/**
 * Stair spawner tests (T-213 v2, ported to LevelDef in T-214).
 *
 * Exercises placeStairs against a hand-rolled LevelDef. Confirms
 * (1) the right prefab fires per lock state, (2) the spawned entity
 * carries a Stair component with the correct lock metadata, and
 * (3) the facing angle points into the wilderness side.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import type { LevelDef } from "@voxim/atlas";
import { Position, Facing, ModelRef } from "./components/game.ts";
import { Stair } from "./components/stair.ts";
import { placeStairs } from "./stair_spawner.ts";

const TILE_SIZE = 16; // small enough to hand-construct buffers

function makeHeightBuffer(): Float32Array {
  return new Float32Array(TILE_SIZE * TILE_SIZE).fill(0.5);
}

/** Build a minimal LevelDef with one path region (zoneId 1) + one plateau
 *  region (zoneId 2) + one stair edge from path → plateau, climbing +X. */
function makeLevel(
  stair: {
    id: string;
    locked: { trinketId: string } | null;
    anchorPixel: { x: number; y: number };
    climbDir?: { dx: number; dy: number };
  },
): LevelDef {
  return {
    gridSize: TILE_SIZE,
    tileSize: TILE_SIZE,
    seed: 0,
    cellX: 0, cellY: 0,
    regions: [
      {
        kind: "path",
        id: "path:z1", zoneId: 1, area: 100,
        centroid: { x: 4, y: 8 }, bbox: { minX: 0, minY: 0, maxX: 7, maxY: 15 },
        pixels: [],
        name: "", topologyRole: "plaza", isEntry: false,
      },
      {
        kind: "plateau",
        id: "plateau:z2", zoneId: 2, area: 100,
        centroid: { x: 12, y: 8 }, bbox: { minX: 8, minY: 0, maxX: 15, maxY: 15 },
        pixels: [],
        name: "", topologyRole: "thicket",
        wallKind: "stone", wallStep: 2, jumpable: false,
      },
    ],
    edges: {
      stairs: [{
        id: stair.id,
        from: "path:z1",
        to: "plateau:z2",
        anchorPixel: stair.anchorPixel,
        climbDir: stair.climbDir ?? { dx: 1, dy: 0 },
        rampDepth: 4, rampHalfWidth: 2,
        locked: stair.locked,
      }],
      portals: [],
    },
    narrative: {
      pois: [], trinkets: [],
      dag: { shape: "linear", entryPoiIds: [], terminalPoiIds: [], degraded: false, retries: 0 },
    },
  };
}

Deno.test("placeStairs: spawns the found prefab and writes unlocked Stair", async () => {
  const world = new World();
  const content = await JsonSource.load();
  const level = makeLevel({
    id: "stair_explore_z2",
    locked: null,
    anchorPixel: { x: 7, y: 8 },
  });

  const placed = placeStairs(world, content, level, makeHeightBuffer(), TILE_SIZE);
  assertEquals(placed, 1);

  let foundStair = false;
  for (const { stair, position, facing, modelRef } of world.query(Stair, Position, Facing, ModelRef)) {
    foundStair = true;
    assertEquals(stair.stairId, "stair_explore_z2");
    assertEquals(stair.toZoneId, 2);
    assertEquals(stair.fromZoneId, 1);
    assertEquals(stair.trinketId, "");
    assertEquals(stair.unlocked, true);
    assertEquals(position.x, 7);
    assertEquals(position.y, 8);
    assertEquals(position.z, 0.5);
    // Climb is +X; facing convention (sin,cos)→(fx,fy). atan2(1,0) = π/2.
    assert(Math.abs(facing.angle - Math.PI / 2) < 1e-6, `facing=${facing.angle}`);
    assertEquals(modelRef.modelId, "model_stair");
  }
  assert(foundStair, "expected a Stair entity in the world");
});

Deno.test("placeStairs: spawns the locked prefab and writes locked Stair", async () => {
  const world = new World();
  const content = await JsonSource.load();
  const level = makeLevel({
    id: "stair_poi_relic_z2",
    locked: { trinketId: "trinket_seal_of_ash" },
    anchorPixel: { x: 7, y: 4 },
  });

  const placed = placeStairs(world, content, level, makeHeightBuffer(), TILE_SIZE);
  assertEquals(placed, 1);

  for (const { stair, modelRef } of world.query(Stair, ModelRef)) {
    assertEquals(stair.stairId, "stair_poi_relic_z2");
    assertEquals(stair.trinketId, "trinket_seal_of_ash");
    assertEquals(stair.unlocked, false);
    assertEquals(modelRef.modelId, "model_stair_locked");
  }
});

Deno.test("placeStairs: skips stairs whose climb direction is degenerate", async () => {
  const world = new World();
  const content = await JsonSource.load();
  const level = makeLevel({
    id: "stair_bogus",
    locked: null,
    anchorPixel: { x: 2, y: 2 },
    climbDir: { dx: 0, dy: 0 },
  });

  const placed = placeStairs(world, content, level, makeHeightBuffer(), TILE_SIZE);
  assertEquals(placed, 0);
  assertEquals([...world.query(Stair)].length, 0);
});
