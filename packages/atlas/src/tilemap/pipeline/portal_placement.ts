/**
 * Stage 4 — portal placement.
 *
 * Each worldmap gate gets stitched into the chamber network with the
 * same bezier carve the network stage uses: pick the nearest chamber
 * by Euclidean distance, draw a curving corridor from the gate's edge
 * pixel to that chamber's centroid. Width sampled per gate from the
 * same `[widthMin, widthMax]` range so gate corridors visually belong
 * to the same family as the chamber-to-chamber ones.
 *
 * Returned `corridors` are appended to the network's; both end up on
 * `TileInit.corridors` for the inspector overlay.
 */

import { runRoomDetection } from "./room_detection.ts";
import { carveBezier, clampPx } from "./bezier_carve.ts";
import type { Corridor, Portal, Room } from "../types.ts";
import type { Edge, GateSpec } from "../../worldmap/types.ts";
import type { GenParams } from "../../genparams.ts";

export interface PortalPlacementInput {
  /** From the network stage. Mutated in place by gate carves. */
  openMask: Uint8Array;
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
    openMask, chambers, gridSize, px2world, tileSize, gates, network, tileSeed,
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

  if (entries.length > 0) {
    if (chambers.length === 0) {
      // No chambers — carve each gate to the tile centre so it at least
      // exists somewhere walkable. (Pathological tile, shouldn't happen.)
      const mid = (gridSize / 2) | 0;
      for (const e of entries) {
        const halfWidth = sampleWidth(rng, network);
        corridors.push(carveBezier({
          ax: e.ex, ay: e.ey, bx: mid, by: mid,
          curvature: network.curvature,
          sign: rng() < 0.5 ? -1 : 1,
          halfWidth,
          samples: network.bezierSamples,
          kind: "portal",
          openMask, gridSize,
        }));
      }
    } else {
      for (const e of entries) {
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
        const tx = clampPx(Math.round(target.cx / px2world), gridSize);
        const ty = clampPx(Math.round(target.cy / px2world), gridSize);
        const halfWidth = sampleWidth(rng, network);
        corridors.push(carveBezier({
          ax: e.ex, ay: e.ey, bx: tx, by: ty,
          curvature: network.curvature,
          sign: rng() < 0.5 ? -1 : 1,
          halfWidth,
          samples: network.bezierSamples,
          kind: "portal",
          openMask, gridSize,
        }));
      }
    }
  }

  // Re-flood: these gate carves merged the gate pixel into a connected
  // component, possibly bridging components that the network stage didn't.
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
