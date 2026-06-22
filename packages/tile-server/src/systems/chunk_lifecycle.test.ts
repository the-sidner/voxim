/**
 * ChunkLifecycleSystem + its pure decision function (T-064).
 *
 * The decision tests hammer the pure load/unload verdict in isolation (no
 * World): in-range stays loaded, out-of-range increments grace then unloads
 * past the window, a cached chunk back in range reloads, an anchor stepping
 * back resets grace. The system test runs the real loop over a real World with
 * real game_config tuning and asserts terrain is cached + destroyed when the
 * anchor leaves and restored byte-for-byte (including a dug cell) when it
 * returns — never lost, never unloaded under the player.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { CHUNK_SIZE, Heightmap, MaterialGrid, OpenMask, KindGrid } from "@voxim/world";
import { createChunk, setChunkHeights } from "@voxim/world";
import { Position } from "../components/game.ts";
import { ChunkLifecycleSystem } from "./chunk_lifecycle.ts";
import {
  chunkKey, decideChunkLifecycle,
  type Anchor, type ChunkCoord,
} from "./chunk_lifecycle_decision.ts";

const DT = 1 / 20;

// Centre of chunk (cx,cy) — handy for placing an anchor right on a chunk.
function centre(cx: number, cy: number): Anchor {
  return { x: (cx + 0.5) * CHUNK_SIZE, y: (cy + 0.5) * CHUNK_SIZE };
}

// ── pure decision ──────────────────────────────────────────────────────────

Deno.test("decision: in-range chunk stays loaded, grace reset to 0", () => {
  const loaded: ChunkCoord[] = [{ chunkX: 5, chunkY: 5 }];
  const grace = new Map<string, number>([[chunkKey(5, 5), 4]]);
  const d = decideChunkLifecycle(
    loaded, new Set(), [centre(5, 5)], grace,
    { loadRadius: CHUNK_SIZE, unloadGraceTicks: 10 },
  );
  assertEquals(d.toUnload, []);
  assertEquals(d.toLoad, []);
  assertEquals(grace.get(chunkKey(5, 5)), 0);
});

Deno.test("decision: out-of-range chunk increments grace, unloads past the window", () => {
  const loaded: ChunkCoord[] = [{ chunkX: 0, chunkY: 0 }];
  const grace = new Map<string, number>();
  // Anchor is far away — chunk (0,0) is always out of range.
  const farAnchor: Anchor[] = [centre(20, 20)];
  const cfg = { loadRadius: CHUNK_SIZE, unloadGraceTicks: 3 };

  // Ticks 1..3 only increment.
  for (let t = 1; t <= 3; t++) {
    const d = decideChunkLifecycle(loaded, new Set(), farAnchor, grace, cfg);
    assertEquals(d.toUnload, [], `tick ${t} should not unload yet`);
    assertEquals(grace.get(chunkKey(0, 0)), t);
  }
  // Tick 4 crosses grace (3) and unloads.
  const d = decideChunkLifecycle(loaded, new Set(), farAnchor, grace, cfg);
  assertEquals(d.toUnload, [{ chunkX: 0, chunkY: 0 }]);
  assert(!grace.has(chunkKey(0, 0)), "grace entry dropped on unload");
});

Deno.test("decision: anchor stepping back into range resets grace before unload", () => {
  const loaded: ChunkCoord[] = [{ chunkX: 0, chunkY: 0 }];
  const grace = new Map<string, number>();
  const cfg = { loadRadius: CHUNK_SIZE, unloadGraceTicks: 5 };
  const far: Anchor[] = [centre(20, 20)];

  decideChunkLifecycle(loaded, new Set(), far, grace, cfg);
  decideChunkLifecycle(loaded, new Set(), far, grace, cfg);
  assertEquals(grace.get(chunkKey(0, 0)), 2);

  // Anchor returns onto the chunk → grace resets, no unload.
  const d = decideChunkLifecycle(loaded, new Set(), [centre(0, 0)], grace, cfg);
  assertEquals(d.toUnload, []);
  assertEquals(grace.get(chunkKey(0, 0)), 0);
});

Deno.test("decision: cached chunk back in range is queued to load", () => {
  const cached = new Set([chunkKey(3, 3), chunkKey(20, 20)]);
  const d = decideChunkLifecycle(
    [], cached, [centre(3, 3)], new Map(),
    { loadRadius: CHUNK_SIZE, unloadGraceTicks: 10 },
  );
  assertEquals(d.toLoad, [{ chunkX: 3, chunkY: 3 }]);
  // (20,20) is far from the anchor → stays cached, not loaded.
});

Deno.test("decision: grace entries for vanished chunks are pruned", () => {
  const grace = new Map<string, number>([[chunkKey(9, 9), 2]]);
  // (9,9) is no longer in the loaded set this tick.
  decideChunkLifecycle(
    [{ chunkX: 0, chunkY: 0 }], new Set(), [centre(0, 0)], grace,
    { loadRadius: CHUNK_SIZE, unloadGraceTicks: 10 },
  );
  assert(!grace.has(chunkKey(9, 9)), "stale grace entry pruned");
});

// ── system over a real World + real config ──────────────────────────────────

const content = await JsonSource.load();

function tick(sys: ChunkLifecycleSystem, world: World): void {
  sys.run(world, new EventBus(), DT);
  world.applyChangeset();
}

Deno.test("system: chunk near an anchor is never unloaded", () => {
  const sys = new ChunkLifecycleSystem(content);
  const w = new World();
  const chunkId = createChunk(w, 8, 8); // centre ~ (272, 272)

  const player = newEntityId();
  w.create(player);
  w.write(player, Position, { x: 272, y: 272, z: 4 });
  w.applyChangeset();

  const grace = content.getGameConfig().world.chunkUnloadGraceTicks;
  for (let t = 0; t < grace + 5; t++) tick(sys, w);

  assert(w.isAlive(chunkId), "chunk under the player must stay loaded");
  assertEquals(sys.cachedCount(), 0);
});

Deno.test("system: distant chunk is cached + destroyed past grace, then restored verbatim", () => {
  const sys = new ChunkLifecycleSystem(content);
  const w = new World();

  // A chunk in the far corner, with a distinctive dug cell so we can prove the
  // cached terrain is restored byte-for-byte rather than regenerated.
  const chunkId = createChunk(w, 15, 15); // centre ~ (496, 496)
  const heights = new Float32Array(CHUNK_SIZE * CHUNK_SIZE).fill(2.0);
  heights[0] = -7.25; // a dig the player made earlier
  setChunkHeights(w, chunkId, heights);

  // Player far away in the opposite corner — chunk (15,15) is out of range.
  const player = newEntityId();
  w.create(player);
  w.write(player, Position, { x: 16, y: 16, z: 4 });
  w.applyChangeset();

  const cfg = content.getGameConfig();
  const grace = cfg.world.chunkUnloadGraceTicks;

  // Sanity: with the shipped 2.0 multiplier the far corner really is out of
  // range of an anchor in the near corner (else this test proves nothing).
  const loadRadius = cfg.network.aoiRadius * cfg.world.chunkLoadRadiusMultiplier;
  const dx = 496 - 16, dy = 496 - 16;
  assert(dx * dx + dy * dy > loadRadius * loadRadius, "far corner must be out of range for the test to be meaningful");

  // Run until just before grace expires — still loaded.
  for (let t = 0; t < grace; t++) tick(sys, w);
  assert(w.isAlive(chunkId), "chunk should survive up to the grace window");

  // One more tick crosses grace → cached + destroyed.
  tick(sys, w);
  assert(!w.isAlive(chunkId), "chunk past grace must be unloaded");
  assertEquals(sys.cachedCount(), 1, "unloaded chunk's terrain is cached");
  // No Heightmap entity remains for that coord.
  assertEquals(w.query(Heightmap).length, 0);

  // Player walks back onto the far chunk → it reloads from cache next tick.
  w.write(player, Position, { x: 496, y: 496, z: 4 });
  w.applyChangeset();
  tick(sys, w);

  const reloaded = w.query(Heightmap);
  assertEquals(reloaded.length, 1, "cached chunk recreated when the anchor returns");
  assertEquals(sys.cachedCount(), 0, "cache emptied on reload");

  const hm = reloaded[0].heightmap;
  assertEquals(hm.chunkX, 15);
  assertEquals(hm.chunkY, 15);
  assertEquals(hm.data[0], -7.25, "dug cell preserved through cache round-trip");
  assertEquals(hm.data[1], 2.0, "untouched cell preserved");

  // Full grid set restored (a missing OpenMask would read as walkable).
  const id = reloaded[0].entityId;
  assert(w.get(id, MaterialGrid) !== null);
  assert(w.get(id, OpenMask) !== null);
  assert(w.get(id, KindGrid) !== null);
});
