/**
 * sweep_math — pure numeric utilities for swept capsule hit detection.
 *
 * Shared by the tile server (action.ts) and the client renderer (trail system).
 * No external dependencies — only plain arithmetic and the SwingKeyframe type.
 *
 * Coordinate convention (server world space):
 *   x = east, y = north, z = up
 *
 * Entity-local space:
 *   fwd   = (cos(facing), sin(facing), 0)
 *   right = (sin(facing), -cos(facing), 0)
 *   up    = (0, 0, 1)
 */

import type { SwingKeyframe } from "./types.ts";

export interface Vec3 { x: number; y: number; z: number }

/**
 * Transform a point from entity-local (fwd, right, up) space to server world space.
 *
 * When facing = 0:  fwd = (1,0,0), right = (0,-1,0), up = (0,0,1)
 * For arbitrary facing f:
 *   fwd   = ( cos(f),  sin(f), 0)
 *   right = ( sin(f), -cos(f), 0)
 *   up    = (0, 0, 1)
 */
export function localToWorld(
  fwd: number, right: number, up: number,
  origin: Vec3, facing: number,
): Vec3 {
  return {
    x: origin.x + fwd * Math.cos(facing) + right * Math.sin(facing),
    y: origin.y + fwd * Math.sin(facing) - right * Math.cos(facing),
    z: origin.z + up,
  };
}

/** Linear interpolation. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Normalize a 3D vector in-place. Returns the original object. */
function normalize(v: { fwd: number; right: number; up: number }): { fwd: number; right: number; up: number } {
  const len = Math.sqrt(v.fwd * v.fwd + v.right * v.right + v.up * v.up);
  if (len > 1e-8) { v.fwd /= len; v.right /= len; v.up /= len; }
  return v;
}

function frameToLocal(kf: SwingKeyframe): {
  hilt: { fwd: number; right: number; up: number };
  bladeDir: { fwd: number; right: number; up: number };
} {
  return {
    hilt:     { fwd: kf.hiltFwd,  right: kf.hiltRight,  up: kf.hiltUp },
    bladeDir: { fwd: kf.bladeFwd, right: kf.bladeRight, up: kf.bladeUp },
  };
}

/**
 * Evaluate the weapon hilt position and blade direction in entity-local
 * (fwd, right, up) space at normalised time t (0..1 over the entire action).
 *
 * bladeDir is a unit vector pointing from hilt toward blade tip.
 * Callers derive the tip: tip = hilt + bladeDir × bladeLength.
 *
 * Keyframes must be sorted by ascending t.
 */
export function evaluateSwingPath(
  keyframes: SwingKeyframe[],
  t: number,
): { hilt: { fwd: number; right: number; up: number };
     bladeDir: { fwd: number; right: number; up: number } } {
  if (keyframes.length === 0) {
    return { hilt: { fwd: 0, right: 0, up: 1 }, bladeDir: { fwd: 1, right: 0, up: 0 } };
  }
  if (t <= keyframes[0].t) return frameToLocal(keyframes[0]);
  if (t >= keyframes[keyframes.length - 1].t) return frameToLocal(keyframes[keyframes.length - 1]);
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i], b = keyframes[i + 1];
    if (t >= a.t && t <= b.t) {
      const alpha = (b.t - a.t) > 0 ? (t - a.t) / (b.t - a.t) : 0;
      return {
        hilt: {
          fwd:   lerp(a.hiltFwd,   b.hiltFwd,   alpha),
          right: lerp(a.hiltRight, b.hiltRight, alpha),
          up:    lerp(a.hiltUp,    b.hiltUp,    alpha),
        },
        // Lerp blade direction then normalize — gives smooth rotation between keyframes
        bladeDir: normalize({
          fwd:   lerp(a.bladeFwd,   b.bladeFwd,   alpha),
          right: lerp(a.bladeRight, b.bladeRight, alpha),
          up:    lerp(a.bladeUp,    b.bladeUp,    alpha),
        }),
      };
    }
  }
  return frameToLocal(keyframes[keyframes.length - 1]);
}

/**
 * Derive the blade tip position from hilt + bladeDir × bladeLength.
 * Convenience helper used by both server (hit detection) and client (trail, IK).
 */
export function deriveTip(
  hilt: { fwd: number; right: number; up: number },
  bladeDir: { fwd: number; right: number; up: number },
  bladeLength: number,
): { fwd: number; right: number; up: number } {
  return {
    fwd:   hilt.fwd   + bladeDir.fwd   * bladeLength,
    right: hilt.right + bladeDir.right * bladeLength,
    up:    hilt.up    + bladeDir.up    * bladeLength,
  };
}

/**
 * Squared closest-approach distance between two line segments (p1→p2) and (q1→q2).
 *
 * Used for capsule-capsule broad tests: a hit occurs when
 *   segSegDistSq(hilt_prev, tip_prev, part_from, part_to) ≤ (bladeRadius + partRadius)²
 *
 * Implementation: Eberly / Real-Time Collision Detection §5.1.9
 */
export function segSegDistSq(p1: Vec3, p2: Vec3, q1: Vec3, q2: Vec3): number {
  const EPSILON = 1e-10;

  const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d1z = p2.z - p1.z;
  const d2x = q2.x - q1.x, d2y = q2.y - q1.y, d2z = q2.z - q1.z;
  const rx  = p1.x - q1.x, ry  = p1.y - q1.y, rz  = p1.z - q1.z;

  const a = d1x*d1x + d1y*d1y + d1z*d1z; // |d1|²
  const e = d2x*d2x + d2y*d2y + d2z*d2z; // |d2|²
  const f = d2x*rx  + d2y*ry  + d2z*rz;  // dot(d2, r)

  let s: number, t: number;

  if (a <= EPSILON && e <= EPSILON) {
    // Both segments degenerate to points
    return rx*rx + ry*ry + rz*rz;
  }

  if (a <= EPSILON) {
    // First segment degenerates to a point
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = d1x*rx + d1y*ry + d1z*rz; // dot(d1, r)
    if (e <= EPSILON) {
      // Second segment degenerates to a point
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      // General non-degenerate case
      const b = d1x*d2x + d1y*d2y + d1z*d2z; // dot(d1, d2)
      const denom = a*e - b*b;

      if (denom > EPSILON) {
        s = Math.max(0, Math.min(1, (b*f - c*e) / denom));
      } else {
        s = 0; // parallel segments — pick s=0 arbitrarily
      }

      t = (b*s + f) / e;

      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }

  const cx = p1.x + d1x*s - (q1.x + d2x*t);
  const cy = p1.y + d1y*s - (q1.y + d2y*t);
  const cz = p1.z + d1z*s - (q1.z + d2z*t);
  return cx*cx + cy*cy + cz*cz;
}
