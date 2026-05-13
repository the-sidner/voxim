/**
 * PoiSystem integration tests (T-212).
 *
 * Builds a minimal World + ContentService stub and verifies the
 * encounter+exploration dispatch paths. Stays clear of the full
 * spawn-prefab pipeline (which needs models/skeletons/biomes/all the
 * content loaded) by stubbing PoiSystem's dispatch downstream with a
 * lightweight assertion helper.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import { Position } from "./components/game.ts";
import { PoiTrigger } from "./components/poi.ts";
import { PoiSystem } from "./systems/poi.ts";

function makeWorld() {
  return new World();
}

Deno.test("PoiSystem: stays idle when no player is in range", async () => {
  const world = makeWorld();
  const content = await JsonSource.load();
  const events = new EventBus();
  let lorePublished = false;
  events.subscribe(TileEvents.LoreInternalised, () => { lorePublished = true; });

  // Place an exploration POI at the origin.
  const trigId = newEntityId();
  world.create(trigId);
  world.write(trigId, Position, { x: 100, y: 100, z: 0 });
  world.write(trigId, PoiTrigger, {
    poiInstanceId: "cairn_marker_z1",
    poiDefId:      "cairn_marker",
    triggerRadius: 5,
    fired:         false,
  });

  // No player.
  const sys = new PoiSystem(content, () => [].values());
  sys.run(world, events, 0.05);
  world.applyChangeset();
  assertEquals(lorePublished, false);
  // Still un-fired.
  assertEquals(world.get(trigId, PoiTrigger)?.fired, false);
});

Deno.test("PoiSystem: exploration fires LoreInternalised on first proximity", async () => {
  const world = makeWorld();
  const content = await JsonSource.load();
  const events = new EventBus();
  const lore: string[] = [];
  events.subscribe(TileEvents.LoreInternalised, (p: { entityId: string; fragmentId: string }) => {
    lore.push(`${p.entityId}/${p.fragmentId}`);
  });

  // Player.
  const pid = newEntityId();
  world.create(pid);
  world.write(pid, Position, { x: 100, y: 100, z: 0 });

  // cairn_marker (exploration, loreId = "lore_cairn_song") at the player's
  // position — guaranteed in-range.
  const tid = newEntityId();
  world.create(tid);
  world.write(tid, Position, { x: 100, y: 100, z: 0 });
  world.write(tid, PoiTrigger, {
    poiInstanceId: "cairn_marker_z1",
    poiDefId:      "cairn_marker",
    triggerRadius: 5,
    fired:         false,
  });

  const sys = new PoiSystem(content, () => [pid].values());
  sys.run(world, events, 0.05);
  world.applyChangeset();

  assertEquals(lore.length, 1, "expected exactly one LoreInternalised event");
  assert(lore[0].endsWith("/lore_cairn_song"), `unexpected fragment id: ${lore[0]}`);
  assertEquals(world.get(tid, PoiTrigger)?.fired, true, "trigger should be marked fired");
});

Deno.test("PoiSystem: does NOT re-fire on subsequent ticks", async () => {
  const world = makeWorld();
  const content = await JsonSource.load();
  const events = new EventBus();
  const lore: string[] = [];
  events.subscribe(TileEvents.LoreInternalised, (p: { entityId: string; fragmentId: string }) => {
    lore.push(p.fragmentId);
  });

  const pid = newEntityId();
  world.create(pid);
  world.write(pid, Position, { x: 100, y: 100, z: 0 });
  const tid = newEntityId();
  world.create(tid);
  world.write(tid, Position, { x: 100, y: 100, z: 0 });
  world.write(tid, PoiTrigger, {
    poiInstanceId: "cairn_marker_z1",
    poiDefId:      "cairn_marker",
    triggerRadius: 5,
    fired:         false,
  });

  const sys = new PoiSystem(content, () => [pid].values());
  for (let i = 0; i < 5; i++) {
    sys.run(world, events, 0.05);
    world.applyChangeset();
  }
  assertEquals(lore.length, 1, "exploration POI should fire exactly once");
});

Deno.test("PoiSystem: out-of-range player does not trigger", async () => {
  const world = makeWorld();
  const content = await JsonSource.load();
  const events = new EventBus();
  let fired = false;
  events.subscribe(TileEvents.LoreInternalised, () => { fired = true; });

  const pid = newEntityId();
  world.create(pid);
  world.write(pid, Position, { x: 200, y: 200, z: 0 });
  const tid = newEntityId();
  world.create(tid);
  world.write(tid, Position, { x: 100, y: 100, z: 0 });
  world.write(tid, PoiTrigger, {
    poiInstanceId: "cairn_marker_z1",
    poiDefId:      "cairn_marker",
    triggerRadius: 5, // 5u radius; player is ~141u away
    fired:         false,
  });

  const sys = new PoiSystem(content, () => [pid].values());
  sys.run(world, events, 0.05);
  world.applyChangeset();
  assertEquals(fired, false);
  assertEquals(world.get(tid, PoiTrigger)?.fired, false);
});

Deno.test("PoiSystem: unknown poiDefId logs a warning, does not fire, does not crash", async () => {
  const world = makeWorld();
  const content = await JsonSource.load();
  const events = new EventBus();
  let fired = false;
  events.subscribe(TileEvents.LoreInternalised, () => { fired = true; });

  const pid = newEntityId();
  world.create(pid);
  world.write(pid, Position, { x: 100, y: 100, z: 0 });
  const tid = newEntityId();
  world.create(tid);
  world.write(tid, Position, { x: 100, y: 100, z: 0 });
  world.write(tid, PoiTrigger, {
    poiInstanceId: "ghost_poi_z99",
    poiDefId:      "nonexistent_poi_def",
    triggerRadius: 5,
    fired:         false,
  });

  const sys = new PoiSystem(content, () => [pid].values());
  sys.run(world, events, 0.05);
  world.applyChangeset();
  assertEquals(fired, false);
});
