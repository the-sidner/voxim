/**
 * PlaceVoxels (T-284 chunk 2) — the server is authoritative over both validity
 * and height: each cell's z is the terrain top + the column's stack × voxelSize
 * (NOT the placer's z), stacking is allowed, and out-of-reach cells are skipped.
 * Runs against real content.
 */
import { assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import { Heightmap } from "@voxim/world";
import { Position } from "../components/game.ts";
import { Equipment } from "../components/equipment.ts";
import { Blueprint } from "../components/building.ts";
import { PlacementSystem } from "./placement.ts";
import type { TickContext } from "../system.ts";

const content = await JsonSource.load();

const EMPTY_EQUIP = {
  weapon: null, offHand: null, head: null, chest: null, legs: null, feet: null, back: null,
};

function run(world: World, actor: string, cmd: CommandPayload): void {
  const sys = new PlacementSystem(content);
  const ctx: TickContext = {
    spatial: null as unknown as TickContext["spatial"],
    pendingCommands: new Map([[actor, [cmd]]]),
  };
  sys.prepare(0, ctx);
  sys.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
}

/** A chunk-(0,0) heightmap whose every cell is `h`. */
function flatHeightmap(world: World, h: number): void {
  const id = newEntityId();
  world.create(id);
  const data = new Float32Array(32 * 32).fill(h);
  world.write(id, Heightmap, { data, chunkX: 0, chunkY: 0 });
}

/** A placer with a hammer equipped (wood_wall requires toolType "hammer"). */
function placer(world: World, x: number, y: number, z: number): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x, y, z });
  world.write(id, Equipment, { ...EMPTY_EQUIP, weapon: { entityId: newEntityId(), prefabId: "stone_hammer" } });
  return id;
}

const wallsZ = (world: World): number[] =>
  world.query(Blueprint, Position)
    .filter((e) => e.blueprint.structureType === "wood_wall")
    .map((e) => e.position.z)
    .sort((a, b) => a - b);

Deno.test("PlaceVoxels stacks voxels in one column, z from terrain top + layer×voxelSize", () => {
  const w = new World();
  flatHeightmap(w, 5.0);                 // terrain top = 5.0 (NOT the placer's z)
  const p = placer(w, 0.5, 0.5, 2.0);    // placer stands at z=2.0

  run(w, p, {
    cmd: CommandType.PlaceVoxels,
    prefabId: "wood_wall",
    voxelSize: 1.0,
    cells: [{ cellX: 0, cellY: 0 }, { cellX: 0, cellY: 0 }],
  });

  // Two walls in the same column: layer 0 on the terrain (5.0), layer 1 on top (6.0).
  // Crucially 5.0, not the placer's 2.0 → z is authoritative from terrain.
  assertEquals(wallsZ(w), [5.0, 6.0]);
});

Deno.test("PlaceVoxels places a line of cells, each on its own column top", () => {
  const w = new World();
  flatHeightmap(w, 3.0);
  const p = placer(w, 1.5, 0.5, 3.0);

  run(w, p, {
    cmd: CommandType.PlaceVoxels,
    prefabId: "wood_wall",
    voxelSize: 1.0,
    cells: [{ cellX: 0, cellY: 0 }, { cellX: 1, cellY: 0 }, { cellX: 2, cellY: 0 }],
  });

  // Three distinct columns, each a single voxel at the terrain top.
  assertEquals(wallsZ(w), [3.0, 3.0, 3.0]);
  assertEquals(w.query(Blueprint).length, 3);
});

Deno.test("PlaceVoxels skips out-of-reach cells (reach is server-authoritative)", () => {
  const w = new World();
  flatHeightmap(w, 4.0);
  const p = placer(w, 0.5, 0.5, 4.0);    // maxReach = 4.0

  run(w, p, {
    cmd: CommandType.PlaceVoxels,
    prefabId: "wood_wall",
    voxelSize: 1.0,
    cells: [{ cellX: 0, cellY: 0 }, { cellX: 100, cellY: 100 }], // far one out of reach
  });

  // Only the in-reach cell placed.
  assertEquals(w.query(Blueprint).length, 1);
  assertEquals(wallsZ(w), [4.0]);
});

Deno.test("PlaceVoxels rejects when the required tool isn't equipped", () => {
  const w = new World();
  flatHeightmap(w, 1.0);
  const id = newEntityId();
  w.create(id);
  w.write(id, Position, { x: 0.5, y: 0.5, z: 1.0 });
  w.write(id, Equipment, { ...EMPTY_EQUIP }); // no hammer

  run(w, id, {
    cmd: CommandType.PlaceVoxels,
    prefabId: "wood_wall",
    voxelSize: 1.0,
    cells: [{ cellX: 0, cellY: 0 }],
  });

  assertEquals(w.query(Blueprint).length, 0);
});
