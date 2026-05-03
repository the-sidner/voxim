/**
 * Gate spawning + proximity-driven handoff (T-140).
 *
 * Server convention: x and y are the horizontal axes, z is vertical (see
 * physics.ts — `getTerrainHeight(x, y)` returns the z plane). Tile geometry
 * is 0..512 in both x and y.
 *
 * Gates sit a few units inside the relevant edge so a player can approach
 * them without clipping the world boundary, and so a freshly-spawned
 * post-handoff player has room to stand before the gate's trigger fires
 * again.
 */
import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import type { GatePosition } from "@voxim/protocol";
import { Position } from "./components/game.ts";
import { GateLink } from "./components/gate.ts";

/** World units. Tile width is 512 in the dev build. */
const TILE_SIZE = 512;
/** Distance from the edge where the gate sits — pad lets handed-off players land on the destination side without re-triggering. */
const GATE_INSET = 8;
/** Trigger radius in world units — must be < GATE_INSET so a re-spawn at the mirrored position doesn't immediately bounce. */
const GATE_RADIUS = 6;

interface XY { x: number; y: number; }

/** Given an edge, the horizontal (x, y) world position where a gate on that edge sits. */
export function gatePositionForEdge(edge: GatePosition["edge"]): XY {
  switch (edge) {
    case "north": return { x: TILE_SIZE / 2, y: GATE_INSET };
    case "south": return { x: TILE_SIZE / 2, y: TILE_SIZE - GATE_INSET };
    case "west":  return { x: GATE_INSET,    y: TILE_SIZE / 2 };
    case "east":  return { x: TILE_SIZE - GATE_INSET, y: TILE_SIZE / 2 };
  }
}

/**
 * Where a player crossing through the *given* edge should arrive on the
 * destination tile. Mirrors the edge: east → west, north → south, etc.
 * Used to compute the post-handoff Position so the player lands just
 * inside the destination's matching gate.
 */
export function mirrorPosition(currentZ: number, edge: GatePosition["edge"]): { x: number; y: number; z: number } {
  switch (edge) {
    case "north": return { x: TILE_SIZE / 2, y: TILE_SIZE - GATE_INSET, z: currentZ };
    case "south": return { x: TILE_SIZE / 2, y: GATE_INSET,             z: currentZ };
    case "west":  return { x: TILE_SIZE - GATE_INSET, y: TILE_SIZE / 2, z: currentZ };
    case "east":  return { x: GATE_INSET,             y: TILE_SIZE / 2, z: currentZ };
  }
}

/** Spawn a Position+GateLink entity per gate in the world cell. */
export function spawnGates(world: World, gates: GatePosition[]): EntityId[] {
  const ids: EntityId[] = [];
  for (const gate of gates) {
    const id = newEntityId();
    const pos = gatePositionForEdge(gate.edge);
    world.create(id);
    world.write(id, Position, { x: pos.x, y: pos.y, z: 0 });
    world.write(id, GateLink, {
      destinationTileId: gate.toTileId,
      edge: gate.edge,
      radius: GATE_RADIUS,
    });
    ids.push(id);
  }
  return ids;
}
