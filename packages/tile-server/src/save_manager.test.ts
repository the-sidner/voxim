/**
 * Save/load entity round-trip (T-251) — SaveManager had zero tests.
 *
 * Asserts the three things the ticket's "done when" demands:
 *   - terrain chunks preserve their FULL grid set (collision via OpenMask,
 *     decoration via KindGrid) — not just Heightmap + MaterialGrid;
 *   - a fixture (resource node) reloads RE-COMPLETED — visual shell (ModelRef
 *     + Hitbox, so weapon_trace can hit it) plus its mutable state (depleted +
 *     the server-only respawn Resource, so it isn't permanently dead);
 *   - a corrupt / truncated payload is rejected WITHOUT mutating the world.
 */

import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import type { ContentService } from "@voxim/content";
import type { TileSaveRepo } from "@voxim/db";
import { Heightmap, MaterialGrid, OpenMask, KindGrid } from "@voxim/world";
import { SaveManager } from "./save_manager.ts";
import { Position, ModelRef } from "./components/game.ts";
import { Hitbox } from "./components/hitbox.ts";
import { Resource } from "./components/resource.ts";
import { ResourceNode } from "./components/resource_node.ts";
import { WorldClock } from "./components/world.ts";
import { spawnPrefab } from "./spawner.ts";

const stubRepo: TileSaveRepo = {
  get: () => Promise.resolve(null),
  put: () => Promise.resolve(),
  delete: () => Promise.resolve(),
};

let content: ContentService;
async function getContent(): Promise<ContentService> {
  if (!content) content = await JsonSource.load("packages/content/data");
  return content;
}

function manager(c: ContentService): SaveManager {
  return new SaveManager(stubRepo, c, "world-test", "0_0");
}

/** Build a chunk entity with a non-default OpenMask (one closed cell) + KindGrid. */
function buildChunk(world: World): { id: string; closedIdx: number; kindIdx: number } {
  const id = newEntityId();
  world.create(id);
  const hm = Heightmap.default();
  hm.chunkX = 2; hm.chunkY = 3;
  world.write(id, Heightmap, hm);
  world.write(id, MaterialGrid, MaterialGrid.default());

  const om = OpenMask.default();          // all-open by default
  const closedIdx = 17 + 9 * 32;
  om.data[closedIdx] = 0;                  // a POI wall cell
  world.write(id, OpenMask, om);

  const kg = KindGrid.default();
  const kindIdx = 5 + 11 * 32;
  kg.data[kindIdx] = 2;                    // a forest-decoration cell
  world.write(id, KindGrid, kg);

  return { id, closedIdx, kindIdx };
}

Deno.test("T-251: chunk round-trips the full grid set (OpenMask + KindGrid survive)", async () => {
  const c = await getContent();
  const src = new World();
  const { id, closedIdx, kindIdx } = buildChunk(src);

  const payload = manager(c).serialize(src);

  const dst = new World();
  assert(manager(c).deserialize(dst, payload));

  assert(dst.has(id, OpenMask), "OpenMask restored — collision survives restart");
  assert(dst.has(id, KindGrid), "KindGrid restored — client decoration survives restart");
  assertEquals(dst.get(id, OpenMask)!.data[closedIdx], 0, "the closed POI-wall cell stays closed");
  assertEquals(dst.get(id, KindGrid)!.data[kindIdx], 2, "the decoration kind id survives");
  assertEquals(dst.get(id, Heightmap)!.chunkX, 2);
});

Deno.test("T-251: a depleted resource node reloads re-completed (shell + mutable state)", async () => {
  const c = await getContent();
  const src = new World();

  const nodeId = spawnPrefab(src, c, "tree", { x: 100.5, y: 64.25 });
  // Simulate a depleted, respawning node: mutable runtime state on top of the
  // fresh spawn (depleted flag + the server-only respawn timer Resource).
  src.write(nodeId, ResourceNode, { nodeTypeId: "tree", hitPoints: 0, depleted: true });
  src.write(nodeId, Resource, { values: { respawn_timer: { value: 5000, max: 12000 } } });

  assert(src.has(nodeId, ModelRef) && src.has(nodeId, Hitbox), "fresh node has a visual shell");

  const payload = manager(c).serialize(src);

  const dst = new World();
  assert(manager(c).deserialize(dst, payload));

  // Re-completed: the spawn pipeline regenerated the shell from the prefab…
  assert(dst.has(nodeId, ModelRef), "ModelRef regenerated — node renders");
  assert(dst.has(nodeId, Hitbox), "Hitbox regenerated — weapon_trace can hit it");
  // …and the mutable state was overlaid back on top.
  assertEquals(dst.get(nodeId, ResourceNode)!.depleted, true, "stays depleted");
  assertEquals(dst.get(nodeId, ResourceNode)!.hitPoints, 0);
  assertEquals(
    dst.get(nodeId, Resource)!.values.respawn_timer.value, 5000,
    "respawn timer preserved — a saved-depleted node still respawns",
  );
  assertAlmostEquals(dst.get(nodeId, Position)!.x, 100.5, 0.01);
  assertAlmostEquals(dst.get(nodeId, Position)!.y, 64.25, 0.01);
});

Deno.test("T-251: WorldClock round-trips", async () => {
  const c = await getContent();
  const src = new World();
  const clockId = newEntityId();
  src.create(clockId);
  src.write(clockId, WorldClock, { ticksElapsed: 7777, dayLengthTicks: 14400 });

  const payload = manager(c).serialize(src);
  const dst = new World();
  assert(manager(c).deserialize(dst, payload));
  assertEquals(dst.get(clockId, WorldClock)!.ticksElapsed, 7777);
});

Deno.test("T-251: a truncated payload is rejected without mutating the world", async () => {
  const c = await getContent();
  const src = new World();
  buildChunk(src);
  spawnPrefab(src, c, "tree", { x: 10, y: 10 });

  const payload = manager(c).serialize(src);
  const truncated = payload.slice(0, payload.byteLength - 12); // chop mid-entity

  const dst = new World();
  assertEquals(manager(c).deserialize(dst, truncated), false, "truncated → rejected");
  assertEquals(dst.entities().length, 0, "world untouched — fresh boot runs on a clean slate");
});

Deno.test("T-251: a non-VXM2 payload is rejected without mutation", async () => {
  const c = await getContent();
  const dst = new World();
  assertEquals(manager(c).deserialize(dst, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), false);
  assertEquals(dst.entities().length, 0);
});
