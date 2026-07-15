/**
 * Gate placement at the carved corridor offset (T-261).
 *
 * Before this, `gatePositionForEdge`/`mirrorPosition` always used
 * `TILE_SIZE / 2` — the raw edge midpoint — while atlas's
 * `portal_placement.ts` carves the tile's only walkable corridor at the
 * worldmap's per-edge `gate.offset`. A midpoint gate can land in a closed
 * pixel whenever the corridor doesn't reach the middle of the edge.
 *
 * These tests are pure-data: they assert the offset propagates end-to-end
 * (GatePosition → spawned GateLink/Position → mirrorPosition) instead of
 * being silently discarded at the midpoint. They can't check the offset
 * against a live atlas OpenMask (no live stack in this lane) — that's the
 * postMergeChecklist item.
 */
import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { World } from "@voxim/engine";
import { TILE_SIZE } from "@voxim/world";
import { gatePositionForEdge, mirrorPosition, spawnGates, type GatePosition } from "./gate.ts";
import { Position } from "./components/game.ts";
import { GateLink } from "./components/gate.ts";

Deno.test("gatePositionForEdge places along the given offset, not the edge midpoint", () => {
  const offset = 120; // far from TILE_SIZE/2 (256)
  assertNotEquals(offset, TILE_SIZE / 2);

  assertEquals(gatePositionForEdge("north", offset), { x: offset, y: 8 });
  assertEquals(gatePositionForEdge("south", offset), { x: offset, y: TILE_SIZE - 8 });
  assertEquals(gatePositionForEdge("west",  offset), { x: 8, y: offset });
  assertEquals(gatePositionForEdge("east",  offset), { x: TILE_SIZE - 8, y: offset });
});

Deno.test("mirrorPosition carries the shared corridor offset onto the mirrored edge", () => {
  const offset = 380;
  assertNotEquals(offset, TILE_SIZE / 2);

  // north <-> south and east <-> west mirror pairs share the same offset
  // value (the worldmap mirror invariant) — the arrival point sits on the
  // SAME along-edge coordinate as the departure gate, not recentred.
  const fromNorth = mirrorPosition(3, "north", offset);
  assertEquals(fromNorth.x, offset);
  assertEquals(fromNorth.z, 3);

  const fromEast = mirrorPosition(3, "east", offset);
  assertEquals(fromEast.y, offset);
});

Deno.test("mirrorPosition arrival stays outside the destination gate's own trigger radius", () => {
  // MIRROR_INSET must exceed GATE_INSET + GATE_RADIUS*2 regardless of
  // offset, so a handed-off player never immediately re-triggers the gate
  // it just arrived through (ping-pong regression guard).
  const offset = 64;
  const arrival = mirrorPosition(0, "north", offset);
  // Arrives near the SOUTH edge (mirrored), well inside TILE_SIZE - 8.
  assertEquals(arrival.y < TILE_SIZE - 8, true);
  assertEquals(arrival.y > TILE_SIZE / 2, true);
});

Deno.test("spawnGates writes the atlas offset onto both Position and GateLink", () => {
  const world = new World();
  const gates: GatePosition[] = [
    { edge: "west", toTileId: "1_0", offset: 90 },
  ];
  const [gateId] = spawnGates(world, gates);

  const pos = world.get(gateId, Position);
  assertEquals(pos, { x: 8, y: 90, z: 0 });

  const link = world.get(gateId, GateLink);
  assertEquals(link?.offset, 90);
  assertEquals(link?.edge, "west");
});
