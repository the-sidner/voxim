/**
 * Stage — rasterise the cell's river segments into the openMask and
 * tag the touched pixels as BOUNDARY_KIND_WATER.
 *
 * Runs AFTER boundary kinds (so kinds has already tagged the noise-built
 * walls) and BEFORE terrain (so terrain sees the river kinds and
 * doesn't accidentally raise them as cliffs).
 *
 * For each RiverSegment:
 *   - Convert both endpoints from world coords (or edge+offset) into
 *     sample-grid pixel coords.
 *   - Bresenham-walk the line, brush a 2-pixel-radius disk at each step.
 *   - Mark every brushed pixel: openMask = 0, kindOf = WATER.
 *
 * The brush IS impassable on its own (closed) — the player needs a
 * future bridge boundary to cross. Visual rendering of water vs.
 * tree vs. cliff happens in tile-server based on the kind tag.
 */

import { BOUNDARY_KIND_WATER } from "./boundary_kinds.ts";
import type { RiverEndpoint, RiverSegment } from "../../worldmap/types.ts";

const RIVER_WIDTH = 2; // brush radius in pixels (so river is ~5 px wide)

export interface RiversInput {
  rivers: RiverSegment[];
  openMask: Uint8Array; // mutated in place
  kindOf:   Uint16Array; // mutated in place
  gridSize: number;
  tileSize: number;
}

export function runRiverStamping(input: RiversInput): void {
  const { rivers, openMask, kindOf, gridSize, tileSize } = input;
  if (rivers.length === 0) return;
  const px2world = tileSize / gridSize;

  for (const seg of rivers) {
    const a = endpointToPixel(seg.a, gridSize, px2world);
    const b = endpointToPixel(seg.b, gridSize, px2world);
    rasterLine(a.x, a.y, b.x, b.y, gridSize, (px, py) => {
      brushDisk(px, py, RIVER_WIDTH, gridSize, openMask, kindOf);
    });
  }
}

function endpointToPixel(
  e: RiverEndpoint,
  gridSize: number,
  px2world: number,
): { x: number; y: number } {
  if (e.edge !== undefined && e.offset !== undefined) {
    const along = Math.round(e.offset / px2world);
    const a = clamp(along, 0, gridSize - 1);
    switch (e.edge) {
      case "north": return { x: a, y: 0 };
      case "south": return { x: a, y: gridSize - 1 };
      case "west":  return { x: 0, y: a };
      case "east":  return { x: gridSize - 1, y: a };
    }
  }
  // Interior terminal — world coords.
  const x = clamp(Math.round((e.x ?? 0) / px2world), 0, gridSize - 1);
  const y = clamp(Math.round((e.y ?? 0) / px2world), 0, gridSize - 1);
  return { x, y };
}

/** 8-connected Bresenham. Calls `pixel` once per step including endpoints. */
function rasterLine(
  x0: number, y0: number, x1: number, y1: number,
  gridSize: number,
  pixel: (px: number, py: number) => void,
): void {
  let x = x0, y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  // Cap to prevent runaway from bad input.
  let safety = gridSize * 4;
  while (safety-- > 0) {
    if (x >= 0 && x < gridSize && y >= 0 && y < gridSize) pixel(x, y);
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 <  dx) { err += dx; y += sy; }
  }
}

/** Stamp a filled disk of `r` pixels around (cx, cy). */
function brushDisk(
  cx: number, cy: number, r: number,
  gridSize: number,
  openMask: Uint8Array, kindOf: Uint16Array,
): void {
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const px = cx + dx, py = cy + dy;
      if (px < 0 || py < 0 || px >= gridSize || py >= gridSize) continue;
      const idx = py * gridSize + px;
      openMask[idx] = 0;
      kindOf[idx]   = BOUNDARY_KIND_WATER;
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
