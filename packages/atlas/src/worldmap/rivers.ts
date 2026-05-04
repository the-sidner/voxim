/**
 * Worldgen river pass — picks source cells deterministically from world
 * seed + biome, walks each river downhill until it terminates, and
 * writes per-cell segments with mirrored entry/exit offsets onto the
 * shared edges (Q6 invariant).
 *
 * Pure function over the partly-built cell array: consumes biome data
 * already present, mutates only `cells[i].rivers`. Same (cells, seed)
 * always produces the same rivers.
 *
 * Sources: every cell tests as a candidate source; a cell qualifies
 * when its altitude is high enough (above SOURCE_ALTITUDE) AND no
 * already-selected source sits in its 3×3 neighbourhood (a poor
 * man's Poisson disk — keeps rivers from clumping). Source order is
 * deterministic via a seeded shuffle so the dedup pass is stable.
 *
 * Walk: from a source, repeatedly pick the lowest-altitude 4-neighbour
 * that's lower than the current cell. Terminate at a local minimum,
 * the world edge, or when revisiting a cell (cycle guard).
 *
 * Each cell on the path gets one RiverSegment with two endpoints. Mid-
 * river cells: edge → edge (entry + exit). Source cells: interior
 * terminal → edge. Sink cells: edge → interior terminal.
 */

import { hash2 } from "../common/noise.ts";
import type { Edge, RiverEndpoint, WorldCellRecord } from "./types.ts";

/** Tile size matches what tile-server uses (mirrors atlas/worldmap/generate.ts). */
const TILE_WORLD_SIZE = 512;
const GATE_INSET = 8;

/** Cells with biome.altitude above this can spawn river sources. */
const SOURCE_ALTITUDE = 0.62;
/** Sources cannot be within this Chebyshev distance of one another. */
const SOURCE_MIN_SEPARATION = 2;

const SEED_RIVER_PICK   = 0x70007001;
const SEED_RIVER_OFFSET = 0x70007003;

export function generateRivers(cells: WorldCellRecord[], width: number, height: number, seed: number): void {
  const cellAt = (cx: number, cy: number): WorldCellRecord | null => {
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) return null;
    return cells[cy * width + cx];
  };

  // ---- pick sources --------------------------------------------------
  const sources: { cx: number; cy: number }[] = [];
  // Walk in a stable order biased by a per-cell hash so two cells with
  // similar altitudes don't always pick the upper-left one as source.
  const order = cells
    .map((c) => ({ c, key: hash2(c.cellX, c.cellY, seed ^ SEED_RIVER_PICK) }))
    .sort((a, b) => a.key - b.key);

  for (const { c } of order) {
    if (c.biome.altitude < SOURCE_ALTITUDE) continue;
    if (tooCloseToExistingSource(c.cellX, c.cellY, sources)) continue;
    sources.push({ cx: c.cellX, cy: c.cellY });
  }

  // ---- walk each river downhill -------------------------------------
  for (const src of sources) {
    walkRiver(src, cellAt, seed);
  }
}

function tooCloseToExistingSource(
  cx: number, cy: number,
  sources: { cx: number; cy: number }[],
): boolean {
  for (const s of sources) {
    if (Math.abs(s.cx - cx) <= SOURCE_MIN_SEPARATION
     && Math.abs(s.cy - cy) <= SOURCE_MIN_SEPARATION) return true;
  }
  return false;
}

function walkRiver(
  src: { cx: number; cy: number },
  cellAt: (cx: number, cy: number) => WorldCellRecord | null,
  seed: number,
): void {
  const visited = new Set<string>();
  let cur = { cx: src.cx, cy: src.cy };
  let entry: RiverEndpoint | null = null; // null = source (no entry)

  while (true) {
    const cell = cellAt(cur.cx, cur.cy);
    if (!cell) break; // walked off the world
    const key = `${cur.cx},${cur.cy}`;
    if (visited.has(key)) break; // cycle guard
    visited.add(key);

    // Pick the lowest-altitude downhill neighbour.
    const next = pickDownhillNeighbour(cur, cell.biome.altitude, cellAt);

    if (next === null) {
      // Sink: terminate inside this cell at its centre-ish.
      const interior: RiverEndpoint = {
        x: TILE_WORLD_SIZE / 2,
        y: TILE_WORLD_SIZE / 2,
      };
      cell.rivers.push({
        a: entry ?? sourceTerminal(cell),
        b: interior,
      });
      return;
    }

    // Continuing: record exit on the shared edge with `next`.
    const exit = exitOnSharedEdge(cur, next, seed);
    cell.rivers.push({
      a: entry ?? sourceTerminal(cell),
      b: exit,
    });
    // Set up the next cell's entry = this cell's exit on the OPPOSITE edge.
    entry = mirroredEntry(exit);
    cur = next;
  }
}

/** Source terminal: a deterministic interior point inside the source cell. */
function sourceTerminal(cell: WorldCellRecord): RiverEndpoint {
  // A modest jitter from cell centre using cell coords + biome — same
  // input twice, same point.
  const jitter = (hash2(cell.cellX, cell.cellY, 0xfeed) - 0.5) * (TILE_WORLD_SIZE * 0.4);
  return {
    x: TILE_WORLD_SIZE / 2 + jitter,
    y: TILE_WORLD_SIZE / 2 - jitter,
  };
}

function pickDownhillNeighbour(
  cur: { cx: number; cy: number },
  curAlt: number,
  cellAt: (cx: number, cy: number) => WorldCellRecord | null,
): { cx: number; cy: number } | null {
  const neighbours: { cx: number; cy: number; alt: number }[] = [];
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
    const n = cellAt(cur.cx + dx, cur.cy + dy);
    if (!n) continue;
    if (n.biome.altitude >= curAlt) continue;
    neighbours.push({ cx: n.cellX, cy: n.cellY, alt: n.biome.altitude });
  }
  if (neighbours.length === 0) return null;
  // Lowest first.
  neighbours.sort((a, b) => a.alt - b.alt);
  return { cx: neighbours[0].cx, cy: neighbours[0].cy };
}

/** Edge on `from` shared with `to`, plus the offset along that edge. */
function exitOnSharedEdge(
  from: { cx: number; cy: number },
  to: { cx: number; cy: number },
  seed: number,
): RiverEndpoint {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  let edge: Edge;
  if      (dx === 1)  edge = "east";
  else if (dx === -1) edge = "west";
  else if (dy === 1)  edge = "south";
  else                edge = "north";

  // Mirror invariant: the offset is keyed on the canonical lower-coord
  // cell of the shared edge, so both sides hash to the same value.
  let kx: number, ky: number;
  switch (edge) {
    case "east":  kx = from.cx;     ky = from.cy;     break;
    case "west":  kx = from.cx - 1; ky = from.cy;     break;
    case "south": kx = from.cx;     ky = from.cy;     break;
    case "north": kx = from.cx;     ky = from.cy - 1; break;
  }
  const h = hash2(kx, ky, seed ^ SEED_RIVER_OFFSET);
  const span = TILE_WORLD_SIZE - 2 * GATE_INSET;
  const offset = GATE_INSET + h * span;
  return { edge, offset };
}

/** The same point on the shared edge, viewed from the OTHER cell. */
function mirroredEntry(exit: RiverEndpoint): RiverEndpoint {
  if (!exit.edge || exit.offset === undefined) return exit;
  const opposite: Record<Edge, Edge> = {
    north: "south", south: "north", east: "west", west: "east",
  };
  return { edge: opposite[exit.edge], offset: exit.offset };
}
