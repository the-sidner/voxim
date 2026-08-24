/**
 * upsertResourceKey's same-tick creation stamp (T-363, the stampedThisRun
 * pattern from ce84943d).
 *
 * `upsertResourceKey` decided set-vs-mutate off `world.has()`, which reads
 * the COMMITTED view. Nothing seeds `Resource` at spawn, so when two
 * DIFFERENT callers seed different keys on the same fresh entity in one
 * tick (a POI proc and a parry's counter_window landing on the same player,
 * say), both saw "absent" and both took the creating `world.set` path — the
 * second set replaced `values` wholesale in the op-log, silently dropping
 * the first caller's key. `stampedThisTick` closes that window the same
 * way `TriggerSystem.stampIcd` / `ActionDispatcher.start` do for their own
 * same-run creation stamps.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { Resource } from "../components/resource.ts";
import { adjustResourceKey, resetResourceStamps, upsertResourceKey } from "./mutate.ts";

Deno.test("two same-tick upserts on a FRESH entity, different keys, both keep their key (no set/set clobber)", () => {
  resetResourceStamps();
  const world = new World();
  const id = newEntityId();
  world.create(id);

  // Neither caller knows about the other — same shape as a POI proc and a
  // parry landing on the same player the same tick.
  upsertResourceKey(world, id, "poi_cue", 1, 1);
  upsertResourceKey(world, id, "counter_window", 40, 40);
  world.applyChangeset();

  const values = world.get(id, Resource)!.values;
  assert(values["poi_cue"], "the first caller's key must survive");
  assert(values["counter_window"], "the second caller's key must survive");
  assertEquals(values["poi_cue"].value, 1);
  assertEquals(values["counter_window"].value, 40);
});

Deno.test("three same-tick upserts on a fresh entity all compose (not just two)", () => {
  resetResourceStamps();
  const world = new World();
  const id = newEntityId();
  world.create(id);

  upsertResourceKey(world, id, "a", 1, 10);
  upsertResourceKey(world, id, "b", 2, 10);
  upsertResourceKey(world, id, "c", 3, 10);
  world.applyChangeset();

  const values = world.get(id, Resource)!.values;
  assertEquals(values["a"]?.value, 1);
  assertEquals(values["b"]?.value, 2);
  assertEquals(values["c"]?.value, 3);
});

Deno.test("re-upserting the SAME key twice in one tick lands the later value", () => {
  resetResourceStamps();
  const world = new World();
  const id = newEntityId();
  world.create(id);

  upsertResourceKey(world, id, "counter_window", 40, 40);
  upsertResourceKey(world, id, "counter_window", 10, 40); // e.g. re-armed shorter
  world.applyChangeset();

  assertEquals(world.get(id, Resource)!.values["counter_window"].value, 10);
});

Deno.test("resetResourceStamps() clears the tracking — a later tick's upsert on an entity that already has Resource composes via world.has, not a stale stamp", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);

  resetResourceStamps();
  upsertResourceKey(world, id, "counter_window", 40, 40);
  world.applyChangeset();
  assert(world.has(id, Resource));

  // Next tick: reset, then an upsert on a DIFFERENT entity with no Resource
  // yet must still take the creating path correctly (the stamp from last
  // tick must not have leaked and shouldn't matter here either way, since
  // this is a different key/entity — this pins that reset actually clears
  // state rather than accumulating forever).
  resetResourceStamps();
  const id2 = newEntityId();
  world.create(id2);
  upsertResourceKey(world, id2, "poi_cue", 1, 1);
  upsertResourceKey(world, id2, "counter_window", 5, 40);
  world.applyChangeset();

  const values2 = world.get(id2, Resource)!.values;
  assert(values2["poi_cue"], "fresh entity still composes correctly after a reset");
  assert(values2["counter_window"]);
});

Deno.test("upsertResourceKey's creating set composes with a same-tick adjustResourceKey (program order, T-249)", () => {
  resetResourceStamps();
  const world = new World();
  const id = newEntityId();
  world.create(id);

  // The upsert's `set` queues first (creates the component + seeds the
  // key); adjustResourceKey's `mutate` queues after it in the SAME op-log
  // key, so per T-249 program order it sees the seeded value and composes
  // on top of it — the creating set is never clobbered.
  upsertResourceKey(world, id, "stamina", 50, 100);
  adjustResourceKey(world, id, "stamina", 10);
  world.applyChangeset();

  assertEquals(world.get(id, Resource)!.values["stamina"]?.value, 60, "the mutate composed on the creating set");
});
