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
import { TILE_SIZE } from "@voxim/world";
import { Position } from "./components/game.ts";
import { GateLink } from "./components/gate.ts";

/** Gate placement on a tile edge, derived from atlas cell metadata at boot. */
export interface GatePosition {
  /** "north" | "south" | "east" | "west" — which edge the gate sits on. */
  edge: "north" | "south" | "east" | "west";
  /** Tile id on the other side of the gate (the destination). */
  toTileId: string;
  /**
   * World-unit offset along the edge's perpendicular axis (atlas
   * `GateSpec.offset` / `Portal.offset`, already in world units — same
   * quantity tile-server's TILE_SIZE and atlas's TILE_WORLD_SIZE both
   * measure, no rescale needed). This is where the carved gate corridor
   * (portal_placement.ts) actually reaches the edge; placing the gate
   * anywhere else (e.g. the edge midpoint) can land it in a closed pixel.
   * Mirror invariant (atlas worldmap/types.ts): the same offset is shared
   * by both cells across a border, so it also gives the correct arrival
   * point on the destination tile's matching edge.
   */
  offset: number;
}

/**
 * Distance from the edge where the gate sits. Numerically matches atlas's
 * own GATE_INSET (packages/atlas/src/worldmap/types.ts) — same physical
 * quantity (inset from a tile edge, same 0..512 coordinate space) but atlas
 * and tile-server can't share one owner across the dependency wall (atlas
 * is upstream; this is gate-*trigger* placement, a tile-server-only
 * concern). Keep the two in sync by hand if either value ever changes.
 */
const GATE_INSET = 8;
/** Trigger radius in world units. */
const GATE_RADIUS = 6;
/**
 * Distance from the edge where a handed-off player lands on the destination
 * tile. Must be strictly greater than `GATE_INSET + GATE_RADIUS` so the
 * landing point sits outside the matching destination gate's trigger circle —
 * otherwise the player would re-trigger a handoff back the other way and
 * ping-pong between tiles every tick.
 */
const MIRROR_INSET = GATE_INSET + GATE_RADIUS * 2 + 4; // 24 units in

interface XY { x: number; y: number; }

/**
 * Given an edge and the carved corridor's along-edge offset (world units,
 * atlas `GateSpec.offset` — see `GatePosition.offset`), the horizontal
 * (x, y) world position where the gate sits: `offset` along the edge, inset
 * `GATE_INSET` from it. Placing at the raw edge midpoint (the pre-T-261
 * behaviour) ignored where atlas actually carved the corridor and could
 * land the trigger in a closed pixel.
 */
export function gatePositionForEdge(edge: GatePosition["edge"], offset: number): XY {
  switch (edge) {
    case "north": return { x: offset, y: GATE_INSET };
    case "south": return { x: offset, y: TILE_SIZE - GATE_INSET };
    case "west":  return { x: GATE_INSET,    y: offset };
    case "east":  return { x: TILE_SIZE - GATE_INSET, y: offset };
  }
}

/**
 * Where a player crossing through the *given* edge should arrive on the
 * destination tile. Mirrors the edge: east → west, north → south, etc.
 * `offset` is the shared corridor offset (mirror invariant — the same
 * value on both sides of the border, see `GatePosition.offset`), so it
 * places the arrival point on the destination's carved corridor too.
 * Used to compute the post-handoff Position so the player lands just
 * inside the destination's matching gate, on an open cell.
 */
export function mirrorPosition(
  currentZ: number,
  edge: GatePosition["edge"],
  offset: number,
): { x: number; y: number; z: number } {
  switch (edge) {
    case "north": return { x: offset, y: TILE_SIZE - MIRROR_INSET, z: currentZ };
    case "south": return { x: offset, y: MIRROR_INSET,             z: currentZ };
    case "west":  return { x: TILE_SIZE - MIRROR_INSET, y: offset, z: currentZ };
    case "east":  return { x: MIRROR_INSET,             y: offset, z: currentZ };
  }
}

/** Spawn a Position+GateLink entity per gate in the world cell. */
export function spawnGates(world: World, gates: GatePosition[]): EntityId[] {
  const ids: EntityId[] = [];
  for (const gate of gates) {
    const id = newEntityId();
    const pos = gatePositionForEdge(gate.edge, gate.offset);
    world.create(id);
    world.write(id, Position, { x: pos.x, y: pos.y, z: 0 });
    world.write(id, GateLink, {
      destinationTileId: gate.toTileId,
      edge: gate.edge,
      radius: GATE_RADIUS,
      offset: gate.offset,
    });
    ids.push(id);
  }
  return ids;
}
