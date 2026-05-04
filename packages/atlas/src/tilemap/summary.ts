/**
 * Gate-summary u16 — packs per-edge gate connectivity into 16 bits.
 *
 *   nibble:   3      2      1      0
 *   edge:     W      S      E      N
 *   value:    component id (0..2) when a gate is present on that edge,
 *             0xF when no gate exists on that edge
 *
 * Two gates with the same nibble are internally connected (their host
 * rooms are the same room — rooms ARE the connected components, so
 * "same room" ≡ "same component"). Two gates with different nibbles are
 * not internally connected. A 0xF nibble means there's no gate to ask
 * about on that edge.
 *
 * Canonicalisation: walk edges in fixed order N → E → S → W. The first
 * present gate gets component 0; each subsequent present gate either
 * reuses the component of an already-seen room or takes the next unused
 * id. Same-shape tiles always pack to the same u16 → equality is `===`.
 *
 * Pure function. Cheap (≤ 4 iterations + a tiny Map). Stored in TileInit.
 */

import type { Edge } from "../worldmap/types.ts";
import type { Portal } from "./types.ts";

/** Edge → nibble position. Matches the storage layout above. */
const EDGE_NIBBLE: Record<Edge, number> = {
  north: 0,
  east:  1,
  south: 2,
  west:  3,
};

/** Walk order for the canonicalisation pass. */
const EDGE_ORDER: readonly Edge[] = ["north", "east", "south", "west"];

/** Sentinel nibble = "no gate on this edge". */
export const NO_GATE = 0xF;

export function deriveGateSummary(portals: Portal[]): number {
  // Index by edge for O(1) lookup in the canonical walk.
  const byEdge: Partial<Record<Edge, Portal>> = {};
  for (const p of portals) byEdge[p.edge] = p;

  const roomToComponent = new Map<number, number>();
  let nextComponent = 0;
  let summary = 0;

  for (const edge of EDGE_ORDER) {
    const p = byEdge[edge];
    let nibble: number;
    if (!p) {
      nibble = NO_GATE;
    } else {
      const existing = roomToComponent.get(p.roomId);
      if (existing !== undefined) {
        nibble = existing;
      } else {
        nibble = nextComponent++;
        roomToComponent.set(p.roomId, nibble);
      }
    }
    summary |= nibble << (EDGE_NIBBLE[edge] * 4);
  }

  return summary;
}

/**
 * Query: starting from gate `from`, can the player exit at gate `to`
 * without leaving this tile? Returns false if either gate is absent.
 */
export function reachable(summary: number, from: Edge, to: Edge): boolean {
  const a = (summary >> (EDGE_NIBBLE[from] * 4)) & 0xF;
  const b = (summary >> (EDGE_NIBBLE[to]   * 4)) & 0xF;
  return a !== NO_GATE && b !== NO_GATE && a === b;
}

/** Read one nibble (component id or 0xF). For inspectors / debug. */
export function nibbleAt(summary: number, edge: Edge): number {
  return (summary >> (EDGE_NIBBLE[edge] * 4)) & 0xF;
}
