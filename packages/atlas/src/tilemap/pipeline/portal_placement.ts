/**
 * Stage 3 — portal placement.
 *
 * For each worldmap gate, compute the edge-entry pixel and carve a
 * straight 1-pixel-wide corridor inward through openMask until it joins
 * an existing open region. After all carves, re-run room detection so
 * the freshly carved pixels are part of a room — then record each
 * portal with its host roomId.
 *
 * The carve is naive (straight line, fixed direction) which is fine
 * because rooms emerge from noise and tend to face the edges; pretty
 * carving (curved, varied width) can land later when boundary kinds
 * exist to make it look natural.
 *
 * Mutates `openMask` and `roomOf` in the returned values; callers should
 * treat them as the new authoritative state.
 */

import { runRoomDetection } from "./room_detection.ts";
import type { Portal, Room } from "../types.ts";
import type { Edge, GateSpec } from "../../worldmap/types.ts";

export interface PortalPlacementInput {
  /** From stage 1. Mutated in place by the carve. */
  openMask: Uint8Array;
  gridSize: number;
  /** World units per pixel. */
  px2world: number;
  /** Tile size in world units (used to clamp offsets into pixel range). */
  tileSize: number;
  /** Per-edge gate from the worldmap. null = no gate on that edge. */
  gates: {
    north: GateSpec | null;
    east:  GateSpec | null;
    south: GateSpec | null;
    west:  GateSpec | null;
  };
}

export interface PortalPlacementOutput {
  /** Updated openMask (carved). Same buffer that was passed in. */
  openMask: Uint8Array;
  /** Re-derived room labelling. */
  rooms: Room[];
  roomOf: Uint16Array;
  /** One portal per present gate. */
  portals: Portal[];
}

const EDGES: readonly Edge[] = ["north", "east", "south", "west"];

export function runPortalPlacement(input: PortalPlacementInput): PortalPlacementOutput {
  const { openMask, gridSize, px2world, tileSize, gates } = input;

  // Entry pixel + inward direction per edge.
  const entries: Array<{ edge: Edge; gate: GateSpec; ex: number; ey: number; dx: number; dy: number }> = [];
  for (const edge of EDGES) {
    const gate = gates[edge];
    if (!gate) continue;
    const along = clamp(Math.round(gate.offset / px2world), 0, gridSize - 1);
    let ex = 0, ey = 0, dx = 0, dy = 0;
    switch (edge) {
      case "north": ex = along;          ey = 0;             dx = 0;  dy = 1;  break;
      case "south": ex = along;          ey = gridSize - 1;  dx = 0;  dy = -1; break;
      case "west":  ex = 0;              ey = along;         dx = 1;  dy = 0;  break;
      case "east":  ex = gridSize - 1;   ey = along;         dx = -1; dy = 0;  break;
    }
    entries.push({ edge, gate, ex, ey, dx, dy });
  }

  // Carve inward until we join an existing open region.
  for (const e of entries) {
    let px = e.ex, py = e.ey;
    while (px >= 0 && px < gridSize && py >= 0 && py < gridSize) {
      const idx = py * gridSize + px;
      if (openMask[idx] === 1) break; // joined an open region
      openMask[idx] = 1;
      px += e.dx;
      py += e.dy;
    }
  }

  // Re-run room detection over the carved openMask.
  const det = runRoomDetection({ openMask, gridSize, px2world });

  // Build portal records, looking up each entry pixel's room.
  const portals: Portal[] = [];
  for (const e of entries) {
    const idx = e.ey * gridSize + e.ex;
    const roomId = det.roomOf[idx];
    if (roomId === 0xFFFF) continue; // shouldn't happen — carve always opens it
    portals.push({
      edge:    e.edge,
      offset:  e.gate.offset,
      pixelX:  e.ex,
      pixelY:  e.ey,
      roomId,
    });
  }

  // Suppress the unused-binding noise about `tileSize` — kept for callers to
  // pass it consistently with the other stages and for future use (when we
  // need to sanity-check that offsets fall in (0, tileSize)).
  void tileSize;

  return { openMask, rooms: det.rooms, roomOf: det.roomOf, portals };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
