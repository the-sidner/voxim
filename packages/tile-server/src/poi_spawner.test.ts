/**
 * placePoiTriggers — scene-prefab subtree path (T-218).
 *
 * A POI def declaring `scenePrefabId` spawns that prefab at the host
 * region centroid; the prefab carries `poiTrigger` (runtime ids patched
 * in) and a child-prop subtree whose world Position is baked off the
 * centroid. POIs without a scene prefab keep the bare-entity fallback.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { emptyLevel, type LevelDef, type PathRegion } from "@voxim/atlas";
import { Position, ModelRef } from "./components/game.ts";
import { PoiTrigger } from "./components/poi.ts";
import { placePoiTriggers } from "./poi_spawner.ts";

const GRID = 512;
const TILE = 512; // scale = TILE / GRID = 1 → centroid maps 1:1 to world

function levelWithPoi(poiDefId: string): LevelDef {
  const level = emptyLevel({ gridSize: GRID, tileSize: TILE, seed: 1, cellX: 0, cellY: 0 });
  const region: PathRegion = {
    kind: "path",
    id: "r1",
    zoneId: 1,
    area: 1,
    centroid: { x: 100, y: 100 },
    bbox: { minX: 99, minY: 99, maxX: 101, maxY: 101 },
    pixels: [100 * GRID + 100],
    name: "Test Region",
    topologyRole: "plaza",
    isEntry: false,
  };
  level.regions.push(region);
  level.narrative.pois.push({
    id: `${poiDefId}_z1`,
    poiDefId,
    hostRegion: "r1",
    gate: { kind: "open", trinketRefs: [] },
    dropsTrinket: null,
    stairEdge: null,
  });
  return level;
}

Deno.test("placePoiTriggers spawns the scene prefab + child subtree (signal_pyre)", async () => {
  const content = await JsonSource.load();
  const world = new World();

  const placed = placePoiTriggers(world, levelWithPoi("signal_pyre"), content, TILE);
  assertEquals(placed, 1);

  // Exactly one PoiTrigger — the scene prefab root (not the torch children).
  const triggers = world.query(PoiTrigger);
  assertEquals(triggers.length, 1);
  const root = triggers[0].entityId;
  const trig = world.get(root, PoiTrigger)!;
  assertEquals(trig.poiInstanceId, "signal_pyre_z1");
  assertEquals(trig.poiDefId, "signal_pyre");
  assertEquals(trig.triggerRadius, 8); // from the prefab, not the default 6
  assertEquals(trig.fired, false);

  // Root sits at the host centroid (scale 1).
  assertEquals(world.get(root, Position), { x: 100, y: 100, z: 0 });

  // Four torch children, parented, world Position = centroid + local.
  const kids = world.getChildren(root);
  assertEquals(kids.length, 4);
  const kidPositions = kids
    .map((k) => {
      assertEquals(world.getParent(k), root);
      assert(world.get(k, ModelRef), "child renders a model");
      const p = world.get(k, Position)!;
      return `${p.x},${p.y}`;
    })
    .sort();
  assertEquals(kidPositions, ["100,103", "100,97", "103,100", "97,100"].sort());
});

Deno.test("placePoiTriggers falls back to a bare trigger when no scene prefab", async () => {
  const content = await JsonSource.load();
  const world = new World();

  // cairn_marker declares no scenePrefabId.
  placePoiTriggers(world, levelWithPoi("cairn_marker"), content, TILE);
  const triggers = world.query(PoiTrigger);
  assertEquals(triggers.length, 1);
  const id = triggers[0].entityId;
  assertEquals(world.getChildren(id).length, 0);
  assertEquals(world.get(id, PoiTrigger)?.poiInstanceId, "cairn_marker_z1");
  assertEquals(world.get(id, Position), { x: 100, y: 100, z: 0 });
});
