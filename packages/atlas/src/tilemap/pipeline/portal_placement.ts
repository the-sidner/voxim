/**
 * Stage 4 — portal placement.
 *
 * Each worldmap gate gets stitched into the chamber network using the
 * same segmented-spline carve the network stage uses. Pick the nearest
 * chamber by Euclidean distance, ray-march from that chamber's centroid
 * toward the gate to find the chamber-boundary pixel facing the gate,
 * and carve a Catmull-Rom spline from gate pixel to chamber boundary.
 *
 * Gate corridors use kind="portal" so the inspector can paint them
 * differently (white) from chamber-to-chamber corridors (cyan).
 */

import { runRoomDetection } from "./room_detection.ts";
import { carveSpline, makeWaypoints, clampPx } from "./bezier_carve.ts";
import type { Corridor, Portal, Room } from "../types.ts";
import type { Edge, GateSpec } from "../../worldmap/types.ts";
import type { GenParams } from "../../genparams.ts";

export interface PortalPlacementInput {
  /** From the network stage. Mutated in place by gate carves. */
  openMask: Uint8Array;
  /** From the chambers stage. Read-only — used to locate chamber boundaries. */
  chamberOf: Uint16Array;
  /** From the network stage. Read-only — we re-flood at the end. */
  chambers: Room[];
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
  /** Re-derived room labelling. */
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
    openMask, chamberOf, chambers, gridSize, px2world, tileSize, gates, network, tileSeed,
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

    if (chambers.length === 0) {
      // Pathological tile — no chambers. Aim at tile centre so the gate
      // at least exists somewhere walkable.
      endPoint = { x: (gridSize / 2) | 0, y: (gridSize / 2) | 0 };
    } else {
      // Nearest chamber by Euclidean distance from gate pixel to centroid.
      let bestId = chambers[0].id;
      let bestD2 = Infinity;
      for (const r of chambers) {
        const rx = r.cx / px2world;
        const ry = r.cy / px2world;
        const dx = rx - e.ex;
        const dy = ry - e.ey;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; bestId = r.id; }
      }
      const target = chambers.find(c => c.id === bestId)!;
      // The chamber-boundary pixel facing the gate.
      endPoint = chamberBoundaryToward(target, gatePoint, chamberOf, gridSize, px2world);
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

  // Re-flood: gate carves merged the gate pixel into a connected
  // component, possibly bridging components that the network stage
  // didn't.
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

/**
 * Ray-march from chamber `from`'s centroid toward the world point `to`,
 * returning the last in-chamber pixel along the way. Mirrors the
 * network stage's helper but accepts an arbitrary target pixel (the
 * gate) instead of another chamber.
 */
function chamberBoundaryToward(
  from: Room, to: { x: number; y: number },
  chamberOf: Uint16Array, gridSize: number, px2world: number,
): { x: number; y: number } {
  const fx = from.cx / px2world;
  const fy = from.cy / px2world;
  const dx = to.x - fx;
  const dy = to.y - fy;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len));
  let lastInside = { x: fx, y: fy };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(fx + dx * t);
    const y = Math.round(fy + dy * t);
    if (x < 0 || x >= gridSize || y < 0 || y >= gridSize) break;
    if (chamberOf[y * gridSize + x] !== from.id) break;
    lastInside = { x, y };
  }
  return lastInside;
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
