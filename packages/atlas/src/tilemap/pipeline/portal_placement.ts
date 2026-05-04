/**
 * Stage 4 — portal placement.
 *
 * After roomify + network, the tile already has a connected room graph.
 * Each worldmap gate gets stitched into that graph with the same noise-flow
 * A* used by the network stage: pick the nearest room centroid by Euclidean
 * distance, carve from the gate's edge pixel to that centroid through the
 * weakest walls. Result: every gate is part of the same network, so the
 * gate-summary u16 honestly reflects "all gates are reachable from each
 * other".
 *
 * Mutates `openMask` and returns refreshed `roomOf` / `rooms[]`.
 */

import { runRoomDetection } from "./room_detection.ts";
import { carveCorridor, clampPx, type CarveContext } from "./carve.ts";
import type { Portal, Room } from "../types.ts";
import type { Edge, GateSpec } from "../../worldmap/types.ts";
import type { GenParams } from "../../genparams.ts";

export interface PortalPlacementInput {
  /** From the network stage. Mutated in place by carves. */
  openMask: Uint8Array;
  /** From the noise stage. Read-only (drives carve cost). */
  noiseField: Float32Array;
  /** Threshold from the noise stage. */
  threshold: number;
  /** From the network stage. Read-only — we re-flood at the end. */
  rooms: Room[];
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
  /** Carve tuning shared with the network stage. */
  network: GenParams["network"];
}

export interface PortalPlacementOutput {
  /** Same buffer as input, with gate corridors carved. */
  openMask: Uint8Array;
  /** Re-derived room labelling. */
  rooms: Room[];
  roomOf: Uint16Array;
  /** One portal per present gate. */
  portals: Portal[];
}

const EDGES: readonly Edge[] = ["north", "east", "south", "west"];

export function runPortalPlacement(input: PortalPlacementInput): PortalPlacementOutput {
  const {
    openMask, noiseField, threshold, rooms,
    gridSize, px2world, tileSize, gates, network,
  } = input;

  // Entry pixel per edge (the pixel on the boundary aligned with the gate offset).
  const entries: Array<{ edge: Edge; gate: GateSpec; ex: number; ey: number }> = [];
  for (const edge of EDGES) {
    const gate = gates[edge];
    if (!gate) continue;
    const along = clampPx(Math.round(gate.offset / px2world), gridSize);
    let ex = 0, ey = 0;
    switch (edge) {
      case "north": ex = along;          ey = 0;            break;
      case "south": ex = along;          ey = gridSize - 1; break;
      case "west":  ex = 0;              ey = along;        break;
      case "east":  ex = gridSize - 1;   ey = along;        break;
    }
    entries.push({ edge, gate, ex, ey });
  }

  // No rooms? carve a single straight corridor from each gate to the centre
  // so the gate at least exists somewhere walkable. (Pathological tile —
  // shouldn't happen with sane params, but the pipeline shouldn't blow up.)
  if (rooms.length === 0) {
    const ctx: CarveContext = {
      openMask, noiseField, threshold, gridSize,
      noiseCostScale: network.noiseCostScale,
      corridorWidth:  network.corridorWidth,
    };
    const mid = (gridSize / 2) | 0;
    for (const e of entries) carveCorridor(e.ex, e.ey, mid, mid, ctx);
  } else {
    const ctx: CarveContext = {
      openMask, noiseField, threshold, gridSize,
      noiseCostScale: network.noiseCostScale,
      corridorWidth:  network.corridorWidth,
    };
    for (const e of entries) {
      // Nearest room centroid (in pixel space) is the carve target.
      let bestId = 0;
      let bestD2 = Infinity;
      for (const r of rooms) {
        const rx = r.cx / px2world;
        const ry = r.cy / px2world;
        const dx = rx - e.ex;
        const dy = ry - e.ey;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; bestId = r.id; }
      }
      const target = rooms[bestId];
      const tx = clampPx(Math.round(target.cx / px2world), gridSize);
      const ty = clampPx(Math.round(target.cy / px2world), gridSize);
      carveCorridor(e.ex, e.ey, tx, ty, ctx);
    }
  }

  // Re-run room detection over the carved openMask. The returned roomOf
  // tells us which (re-labelled) component each gate pixel landed in.
  const det = runRoomDetection({ openMask, gridSize, px2world });

  // Build portal records.
  const portals: Portal[] = [];
  for (const e of entries) {
    const idx = e.ey * gridSize + e.ex;
    const roomId = det.roomOf[idx];
    if (roomId === 0xFFFF) continue; // shouldn't happen — carve always opens it.
    portals.push({
      edge:    e.edge,
      offset:  e.gate.offset,
      pixelX:  e.ex,
      pixelY:  e.ey,
      roomId,
    });
  }

  // tileSize kept in the API for symmetry with other stages and for future
  // sanity-checking that gate offsets fall in (0, tileSize).
  void tileSize;

  return { openMask, rooms: det.rooms, roomOf: det.roomOf, portals };
}
