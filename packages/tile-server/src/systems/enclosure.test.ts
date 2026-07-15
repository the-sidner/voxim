/**
 * EnclosureSystem (T-065 server core, T-066 wire face) — the World-facing
 * wrapper around the pure detectEnclosedCells flood-fill. Covers the two
 * behaviours enclosure_detector.test.ts can't: assembling a wall grid from
 * live chunk OpenMask data, and publishing TileEvents.EnclosureChanged only
 * when a recompute actually changes the enclosed-cell set.
 */
import { assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import { Heightmap, OpenMask, CHUNK_SIZE } from "@voxim/world";
import { EnclosureSystem } from "./enclosure.ts";

/** A single-chunk world at (0,0) with every OpenMask cell OPEN (1). */
function singleOpenChunkWorld(): World {
  const w = new World();
  const id = newEntityId();
  w.create(id);
  w.write(id, Heightmap, { data: new Float32Array(CHUNK_SIZE * CHUNK_SIZE), chunkX: 0, chunkY: 0 });
  w.write(id, OpenMask, { data: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE).fill(1) });
  return w;
}

/** Punch a WALL ring (OpenMask=0) around the interior rectangle [x0,x1)×[y0,y1). */
function wallRing(w: World, x0: number, y0: number, x1: number, y1: number): void {
  const { entityId } = w.query(OpenMask)[0];
  const om = w.get(entityId, OpenMask)!;
  const data = om.data;
  for (let x = x0; x < x1; x++) {
    data[x + y0 * CHUNK_SIZE] = 0;
    data[x + (y1 - 1) * CHUNK_SIZE] = 0;
  }
  for (let y = y0; y < y1; y++) {
    data[x0 + y * CHUNK_SIZE] = 0;
    data[(x1 - 1) + y * CHUNK_SIZE] = 0;
  }
}

Deno.test("EnclosureSystem: first run with no chunks loaded computes an empty set, no event (nothing changed)", () => {
  const w = new World();
  const bus = new EventBus();
  const events: unknown[] = [];
  bus.subscribe(TileEvents.EnclosureChanged, (p) => events.push(p));

  const sys = new EnclosureSystem();
  sys.run(w, bus, 1 / 20);

  assertEquals(sys.enclosedCells().size, 0);
  assertEquals(events.length, 0);
});

Deno.test("EnclosureSystem: sealing a ring publishes EnclosureChanged with the enclosed cells", () => {
  const w = singleOpenChunkWorld();
  wallRing(w, 4, 4, 9, 9); // 5×5 ring → 3×3 interior enclosed

  const bus = new EventBus();
  const received: { cells: { x: number; y: number }[] }[] = [];
  bus.subscribe(TileEvents.EnclosureChanged, (p: { cells: { x: number; y: number }[] }) => received.push(p));

  const sys = new EnclosureSystem();
  sys.markDirty();
  sys.run(w, bus, 1 / 20);

  assertEquals(sys.enclosedCells().size, 9);
  assertEquals(sys.isEnclosed(6, 6), true);
  assertEquals(sys.isEnclosed(0, 0), false);

  assertEquals(received.length, 1);
  assertEquals(received[0].cells.length, 9);
  const has = (x: number, y: number) => received[0].cells.some((c) => c.x === x && c.y === y);
  assertEquals(has(6, 6), true);
  assertEquals(has(4, 4), false); // wall cell itself never enclosed
});

Deno.test("EnclosureSystem: a recompute that reproduces the same set publishes no event", () => {
  const w = singleOpenChunkWorld();
  wallRing(w, 4, 4, 9, 9);

  const bus = new EventBus();
  let count = 0;
  bus.subscribe(TileEvents.EnclosureChanged, () => count++);

  const sys = new EnclosureSystem();
  sys.markDirty();
  sys.run(w, bus, 1 / 20);
  assertEquals(count, 1);

  // Recompute again without anything actually changing the topology.
  sys.markDirty();
  sys.run(w, bus, 1 / 20);
  assertEquals(count, 1, "identical recompute must not re-publish");
});

Deno.test("EnclosureSystem: punching a gap in the ring re-publishes with an empty (or smaller) set", () => {
  const w = singleOpenChunkWorld();
  wallRing(w, 4, 4, 9, 9);

  const bus = new EventBus();
  const received: { cells: { x: number; y: number }[] }[] = [];
  bus.subscribe(TileEvents.EnclosureChanged, (p: { cells: { x: number; y: number }[] }) => received.push(p));

  const sys = new EnclosureSystem();
  sys.markDirty();
  sys.run(w, bus, 1 / 20);
  assertEquals(received.length, 1);
  assertEquals(received[0].cells.length, 9);

  // Punch the east wall of the ring open.
  const { entityId } = w.query(OpenMask)[0];
  const om = w.get(entityId, OpenMask)!;
  om.data[8 + 6 * CHUNK_SIZE] = 1;

  sys.markDirty();
  sys.run(w, bus, 1 / 20);

  assertEquals(received.length, 2);
  assertEquals(received[1].cells.length, 0);
  assertEquals(sys.isEnclosed(6, 6), false);
});

Deno.test("EnclosureSystem: run() is a no-op when not dirty", () => {
  const w = singleOpenChunkWorld();
  wallRing(w, 4, 4, 9, 9);

  const bus = new EventBus();
  let count = 0;
  bus.subscribe(TileEvents.EnclosureChanged, () => count++);

  const sys = new EnclosureSystem();
  sys.run(w, bus, 1 / 20); // starts dirty=true
  assertEquals(count, 1);

  // Mutate the grid but never mark dirty — run() must skip recompute entirely.
  const { entityId } = w.query(OpenMask)[0];
  w.get(entityId, OpenMask)!.data[8 + 6 * CHUNK_SIZE] = 1;
  sys.run(w, bus, 1 / 20);
  assertEquals(count, 1, "non-dirty run must not recompute or publish");
});
