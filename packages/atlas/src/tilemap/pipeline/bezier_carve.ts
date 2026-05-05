/**
 * Spline corridor carving — shared by the network and portal stages.
 *
 * A corridor is a polyline of waypoints carved as a Catmull-Rom spline:
 * each segment between consecutive waypoints w[i] and w[i+1] is rendered
 * as a cubic bezier with control points derived from the neighbouring
 * waypoints w[i-1] and w[i+2]. The result passes through every waypoint
 * with C1 continuity at the joints (no kinks, gentle bends only).
 *
 *   c1 = w[i]   + (w[i+1] − w[i-1]) / 6
 *   c2 = w[i+1] − (w[i+2] − w[i])   / 6
 *
 * For the first/last segments the missing neighbour is reflected
 * (`phantom = 2·w[end] − w[adj]`) so the curve still passes cleanly
 * through the endpoints.
 *
 * Each segment is sampled at `samplesPerSegment` parameter values; at
 * each sample a square brush of `halfWidth` pixels is stamped into
 * `openMask`. Returns the `Corridor` record so the caller can persist
 * the waypoints on TileInit (the inspector renders centerlines from
 * these by replaying the same Catmull-Rom math).
 */

import type { Corridor } from "../types.ts";

export interface CarveSplineInput {
  /** ≥ 2 waypoints (endpoints + interior). Pixel coords; sub-pixel allowed. */
  waypoints: Array<{ x: number; y: number }>;
  /** Brush half-width (Chebyshev). 0 = 1px wide, 1 = 3px, … */
  halfWidth: number;
  /** Samples per spline segment. */
  samplesPerSegment: number;
  /** "network" or "portal" — recorded on the Corridor for the inspector. */
  kind: Corridor["kind"];
  openMask: Uint8Array;
  gridSize: number;
}

export function carveSpline(input: CarveSplineInput): Corridor {
  const { waypoints, halfWidth, samplesPerSegment, kind, openMask, gridSize } = input;
  if (waypoints.length < 2) {
    // Degenerate: single point. Stamp once and bail out with a 2-point
    // record so consumers always see a valid polyline.
    if (waypoints.length === 1) {
      stampBrush(openMask, gridSize, Math.round(waypoints[0].x), Math.round(waypoints[0].y), halfWidth);
    }
    return { kind, waypoints: waypoints.slice(), halfWidth };
  }

  const N = waypoints.length;
  let prevX = -1, prevY = -1;
  // Iterate spline segments [i, i+1] for i in 0..N-2.
  for (let i = 0; i < N - 1; i++) {
    const w0 = waypoints[i - 1] ?? reflect(waypoints[i], waypoints[i + 1]);
    const w1 = waypoints[i];
    const w2 = waypoints[i + 1];
    const w3 = waypoints[i + 2] ?? reflect(waypoints[i + 1], waypoints[i]);
    // Catmull-Rom → cubic bezier control points (uniform parameterisation).
    const c1x = w1.x + (w2.x - w0.x) / 6;
    const c1y = w1.y + (w2.y - w0.y) / 6;
    const c2x = w2.x - (w3.x - w1.x) / 6;
    const c2y = w2.y - (w3.y - w1.y) / 6;
    for (let s = 0; s <= samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const u = 1 - t;
      const tt = t * t, uu = u * u;
      const ttt = tt * t, uuu = uu * u;
      const x = uuu * w1.x + 3 * uu * t * c1x + 3 * u * tt * c2x + ttt * w2.x;
      const y = uuu * w1.y + 3 * uu * t * c1y + 3 * u * tt * c2y + ttt * w2.y;
      const px = Math.round(x);
      const py = Math.round(y);
      if (px === prevX && py === prevY) continue;
      prevX = px; prevY = py;
      stampBrush(openMask, gridSize, px, py, halfWidth);
    }
  }
  return { kind, waypoints: waypoints.slice(), halfWidth };
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

/** Reflect `near` across `pivot` — used to synthesise endpoint neighbours. */
function reflect(pivot: { x: number; y: number }, near: { x: number; y: number }): { x: number; y: number } {
  return { x: 2 * pivot.x - near.x, y: 2 * pivot.y - near.y };
}

/**
 * Generate `segments + 1` waypoints from `start` to `end`, with interior
 * waypoints perpendicular-perturbed by `curvature × edgeLen × random` and
 * tapered with a sin envelope (so the perturbation goes to zero at the
 * endpoints — they stay anchored). Each interior waypoint is clamped to
 * a margin inside the tile so the spline never excursions out.
 */
export function makeWaypoints(
  start:    { x: number; y: number },
  end:      { x: number; y: number },
  segments: number,
  curvature: number,
  margin:   number,
  gridSize: number,
  rng:      () => number,
): Array<{ x: number; y: number }> {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (segments <= 1 || len < 1) return [start, end];
  // Perpendicular unit vector (rotate by +90°).
  const nx = -dy / len;
  const ny =  dx / len;
  const amplitude = curvature * len;
  const out: Array<{ x: number; y: number }> = [start];
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const baseX = start.x + dx * t;
    const baseY = start.y + dy * t;
    // Sin envelope tapers perturbation to 0 at endpoints.
    const env = Math.sin(Math.PI * t);
    // Symmetric ±1 jitter per waypoint.
    const off = (rng() * 2 - 1) * amplitude * env;
    const x = clamp(baseX + nx * off, margin, gridSize - 1 - margin);
    const y = clamp(baseY + ny * off, margin, gridSize - 1 - margin);
    out.push({ x, y });
  }
  out.push(end);
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clampPx(v: number, gridSize: number): number {
  return v < 0 ? 0 : v >= gridSize ? gridSize - 1 : v;
}
