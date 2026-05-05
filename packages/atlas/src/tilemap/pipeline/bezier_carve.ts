/**
 * Bezier corridor carving — the network and portal stages share this.
 *
 * One corridor = one quadratic bezier curve between two endpoints, with
 * a perpendicular-displaced control point so the path arcs instead of
 * cutting straight. The curve is densely sampled and a square brush of
 * `halfWidth` pixels is stamped at each sample point into `openMask`.
 *
 *   B(t) = (1-t)² · A + 2(1-t)t · CP + t² · B
 *
 * Per-edge curvature sign is supplied by the caller (deterministic from
 * a tile-seeded PRNG) so different tiles get different bend directions.
 *
 * Returns the carved Corridor record so the caller can persist it on
 * TileInit (the inspector renders centerlines from these).
 */

import type { Corridor } from "../types.ts";

export interface BezierCarveInput {
  /** Endpoint A (pixel coords). */
  ax: number; ay: number;
  /** Endpoint B (pixel coords). */
  bx: number; by: number;
  /** Control-point displacement, fraction of edge length. 0 = straight. */
  curvature: number;
  /** ±1, picks which side of the line the bend goes. */
  sign: number;
  /** Brush half-width, pixels (Chebyshev). 0 = 1px wide, 1 = 3px, … */
  halfWidth: number;
  /** Number of samples along the curve. */
  samples: number;
  /** "network" or "portal" — recorded on the Corridor for the inspector. */
  kind: Corridor["kind"];
  openMask: Uint8Array;
  gridSize: number;
}

export function carveBezier(input: BezierCarveInput): Corridor {
  const { ax, ay, bx, by, curvature, sign, halfWidth, samples, kind, openMask, gridSize } = input;

  // Control point: midpoint, shifted perpendicular to AB by `curvature * |AB|`.
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular unit vector (rotate AB by +90°).
  const px = -dy / len;
  const py =  dx / len;
  const off = curvature * len * sign;
  const cpx = mx + px * off;
  const cpy = my + py * off;

  // Sample + stamp.
  let prevX = -1, prevY = -1;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    const x = Math.round(u * u * ax + 2 * u * t * cpx + t * t * bx);
    const y = Math.round(u * u * ay + 2 * u * t * cpy + t * t * by);
    if (x === prevX && y === prevY) continue;
    prevX = x; prevY = y;
    stampBrush(openMask, gridSize, x, y, halfWidth);
  }

  return { kind, ax, ay, cpx, cpy, bx, by, halfWidth };
}

/** Open every pixel within Chebyshev `halfWidth` of (x, y). */
function stampBrush(openMask: Uint8Array, gridSize: number, x: number, y: number, halfWidth: number): void {
  const x0 = Math.max(0, x - halfWidth);
  const x1 = Math.min(gridSize - 1, x + halfWidth);
  const y0 = Math.max(0, y - halfWidth);
  const y1 = Math.min(gridSize - 1, y + halfWidth);
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      openMask[py * gridSize + px] = 1;
    }
  }
}

export function clampPx(v: number, gridSize: number): number {
  return v < 0 ? 0 : v >= gridSize ? gridSize - 1 : v;
}
