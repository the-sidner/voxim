/**
 * Stage 5 — portal placement.
 *
 * Each worldmap gate gets stitched into the path network: pick the
 * nearest junction by Euclidean distance and carve a Catmull-Rom spline
 * from the gate's edge pixel to that junction's position. Same carve
 * primitive the network stage uses; same per-edge brush width range.
 *
 * Gate corridors use kind="portal" so the inspector can paint them
 * differently (white) from network corridors (cyan).
 *
 * Junctions are points (no extent), so there's no boundary-pixel
 * search — the gate corridor terminates exactly at the junction.
 * After this stage we re-flood `roomOf` so the gate-summary can find
 * which connected component the gate landed in.
 */

import { runRoomDetection } from "./room_detection.ts";
import { carveSpline, makeWaypoints, clampPx } from "./bezier_carve.ts";
import type { Junction } from "./junctions.ts";
import type { Corridor, Portal, Room } from "../types.ts";
import type { Edge, GateSpec } from "../../worldmap/types.ts";
import type { GenParams } from "../../genparams.ts";

export interface PortalPlacementInput {
  /** From the rooms stage. Mutated in place by gate carves. */
  openMask: Uint8Array;
  /** From the junctions stage. Read-only — gate carves target nearest. */
  seeds: Junction[];
  gridSize: number;
  px2world: number;
  /** Tile size in world units (used to clamp gate offsets). */
  tileSize: number;
  /** Per-edge gate from the worldmap. null = no gate on that edge. */
  gates: {
    north: GateSpec | null;
    east:  GateSpec | null;
    south: GateSpec | null;
    west:  GateSpec | null;
  };
  /** Carve tuning — same knobs the network stage uses. */
  network: GenParams["network"];
  tileSeed: number;
}

export interface PortalPlacementOutput {
  /** Same buffer as input, with gate corridors carved. */
  openMask: Uint8Array;
  /** Re-derived room labelling (connected components after all carves). */
  rooms: Room[];
  roomOf: Uint16Array;
  /** One portal per present gate. */
  portals: Portal[];
  /** Carved gate-corridor records (kind = "portal"). */
  corridors: Corridor[];
}

const PORTAL_SUB_SEED = 0xB0AA0001;
const EDGES: readonly Edge[] = ["north", "east", "south", "west"];

export function runPortalPlacement(input: PortalPlacementInput): PortalPlacementOutput {
  const {
    openMask, seeds, gridSize, px2world, tileSize, gates, network, tileSeed,
  } = input;

  // Entry pixel per edge.
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

  const corridors: Corridor[] = [];
  const rng = mulberry32(tileSeed ^ PORTAL_SUB_SEED);

  for (const e of entries) {
    const halfWidth = sampleWidth(rng, network);
    const margin = halfWidth + 2;
    const gatePoint = { x: e.ex, y: e.ey };
    let endPoint: { x: number; y: number };

    if (seeds.length === 0) {
      // Pathological tile — no junctions. Aim at tile centre so the gate
      // at least exists somewhere walkable.
      endPoint = { x: (gridSize / 2) | 0, y: (gridSize / 2) | 0 };
    } else {
      // Nearest junction by Euclidean distance.
      let best = seeds[0];
      let bestD2 = Infinity;
      for (const s of seeds) {
        const dx = s.x - e.ex;
        const dy = s.y - e.ey;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = s; }
      }
      endPoint = { x: best.x, y: best.y };
    }

    const waypoints = makeWaypoints(
      gatePoint, endPoint, network.segments, network.curvature, margin, gridSize, rng,
    );
    corridors.push(carveSpline({
      waypoints,
      halfWidth,
      samplesPerSegment: network.bezierSamples,
      kind: "portal",
      openMask,
      gridSize,
    }));
  }

  // Re-flood: gate carves merged the gate pixel into a connected component.
  const det = runRoomDetection({ openMask, gridSize, px2world });

  const portals: Portal[] = [];
  for (const e of entries) {
    const idx = e.ey * gridSize + e.ex;
    const roomId = det.roomOf[idx];
    if (roomId === 0xFFFF) continue;
    portals.push({
      edge:    e.edge,
      offset:  e.gate.offset,
      pixelX:  e.ex,
      pixelY:  e.ey,
      roomId,
    });
  }

  void tileSize;
  return { openMask, rooms: det.rooms, roomOf: det.roomOf, portals, corridors };
}

function sampleWidth(rng: () => number, params: GenParams["network"]): number {
  const lo = Math.min(params.widthMin, params.widthMax);
  const hi = Math.max(params.widthMin, params.widthMax);
  if (lo === hi) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
