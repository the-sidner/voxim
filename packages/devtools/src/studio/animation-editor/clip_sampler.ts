/**
 * Sample a clip's bone rotations at normalized time t ∈ [0, 1].
 *
 * Same shape as engine's evaluateAnimationLayers but trimmed to a
 * single-layer override evaluation — the studio doesn't need the full
 * mask + blend stack for the basic clip player. The full evaluator
 * still lives in @voxim/content and the engine uses it; this is a
 * deliberate copy to keep Layer A free of game-content imports.
 *
 * Tracks not present in the clip leave the bone at its rest rotation
 * (caller handles fallback via SkeletonView.applyPose).
 */

export interface Keyframe { time: number; rotX: number; rotY: number; rotZ: number }

export interface ClipLike {
  loop: boolean;
  durationSeconds?: number;
  tracks: Record<string, Keyframe[]>;
}

export interface BoneRot { x: number; y: number; z: number }

const TWO_PI = Math.PI * 2;

/** Shortest-arc lerp delta — matches engine animation_eval.ts. */
function arcDelta(a: number, b: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return d;
}

function sampleTrack(track: Keyframe[], t: number): BoneRot {
  if (track.length === 0) return { x: 0, y: 0, z: 0 };
  if (track.length === 1) return { x: track[0].rotX, y: track[0].rotY, z: track[0].rotZ };
  const tc = Math.max(0, Math.min(1, t));
  if (tc <= track[0].time) return { x: track[0].rotX, y: track[0].rotY, z: track[0].rotZ };
  const last = track[track.length - 1];
  if (tc >= last.time) return { x: last.rotX, y: last.rotY, z: last.rotZ };

  let lo = 0, hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (track[mid].time <= tc) lo = mid; else hi = mid;
  }
  const a = track[lo], b = track[hi];
  const span = b.time - a.time;
  const alpha = span > 1e-9 ? (tc - a.time) / span : 0;
  return {
    x: a.rotX + arcDelta(a.rotX, b.rotX) * alpha,
    y: a.rotY + arcDelta(a.rotY, b.rotY) * alpha,
    z: a.rotZ + arcDelta(a.rotZ, b.rotZ) * alpha,
  };
}

/** Returns Map<boneId, rotation> for all bones touched by the clip at time t. */
export function sampleClipAtTime(clip: ClipLike, normalizedT: number): Map<string, BoneRot> {
  const out = new Map<string, BoneRot>();
  for (const [boneId, track] of Object.entries(clip.tracks)) {
    out.set(boneId, sampleTrack(track, normalizedT));
  }
  return out;
}
