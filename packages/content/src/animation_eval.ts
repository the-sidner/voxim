/**
 * Animation layer evaluator — shared between server (HitboxSystem) and client
 * (skeleton_evaluator.ts).
 *
 * Works in the same coordinate space as skeleton_solver.ts (x=right, y=up, z=-fwd).
 * Bone rotations are Euler XYZ in radians — the format solveSkeleton() expects.
 *
 * Performance notes:
 *   - Pass an `out` map to reuse storage across ticks (zero allocation on hot path).
 *   - ClipIndex / maskIndex are pre-built once by ContentStore and passed in as refs.
 *   - Binary search over keyframes is O(log K) per bone per layer.
 */

import type { SkeletonDef, AnimationClip, AnimationLayer, BoneMask, AnimationKeyframe } from "./types.ts";
import type { BoneRotation } from "./ik_solver.ts";

/**
 * Build a clip lookup map for a skeleton (clipId → AnimationClip).
 * Pre-computed once by ContentStore.getClipIndex().
 */
export function buildClipIndex(skeleton: SkeletonDef): ReadonlyMap<string, AnimationClip> {
  const m = new Map<string, AnimationClip>();
  for (const clip of skeleton.clips ?? []) {
    m.set(clip.id, clip);
  }
  return m;
}

/**
 * Build a bone mask lookup map for a skeleton (maskId → BoneMask).
 * Pre-computed once by ContentStore.getMaskIndex().
 *
 * Throws on duplicate mask ids — silently keeping one and dropping the
 * other would surface as missing bones in animation layers.
 */
export function buildMaskIndex(skeleton: SkeletonDef): ReadonlyMap<string, BoneMask> {
  const m = new Map<string, BoneMask>();
  for (const mask of skeleton.boneMasks ?? []) {
    if (m.has(mask.id)) {
      throw new Error(`skeleton "${skeleton.id}": duplicate boneMask id "${mask.id}"`);
    }
    m.set(mask.id, mask);
  }
  return m;
}

/**
 * Evaluate a stack of animation layers and return combined bone rotations.
 *
 * Layers are processed bottom→top. Each layer blends its sampled clip pose onto
 * the result for the bones covered by its mask. Weight controls blend strength.
 *
 * @param skeleton   Skeleton definition — bones must be in parent-before-child order.
 * @param clipIndex  Pre-built clip map from ContentStore.getClipIndex(skeletonId).
 * @param maskIndex  Pre-built mask map from ContentStore.getMaskIndex(skeletonId).
 * @param layers     Ordered animation layer stack, bottom to top.
 * @param out        Optional output map reused across calls — cleared on entry.
 * @returns          Map from boneId to Euler XYZ BoneRotation (radians), for solveSkeleton().
 */
export function evaluateAnimationLayers(
  skeleton: SkeletonDef,
  clipIndex: ReadonlyMap<string, AnimationClip>,
  maskIndex: ReadonlyMap<string, BoneMask>,
  layers: readonly AnimationLayer[],
  out?: Map<string, BoneRotation>,
): Map<string, BoneRotation> {
  const result: Map<string, BoneRotation> = out ?? new Map();
  if (out) out.clear();

  // Initialize every bone to rest pose (zero Euler rotation).
  for (const bone of skeleton.bones) {
    result.set(bone.id, { x: 0, y: 0, z: 0 });
  }

  for (const layer of layers) {
    if (layer.weight <= 0) continue;

    const clip = clipIndex.get(layer.clipId);
    if (!clip) continue;

    // Resolve bone mask: empty maskId = full body.
    let maskedBones: ReadonlySet<string> | null = null;
    if (layer.maskId) {
      const mask = maskIndex.get(layer.maskId);
      if (mask) maskedBones = new Set(mask.boneIds);
    }

    const w = layer.weight;
    const t = layer.time;

    for (const bone of skeleton.bones) {
      // Skip bones not covered by this layer's mask.
      if (maskedBones !== null && !maskedBones.has(bone.id)) continue;

      // Sample this clip for the bone at normalized time t.
      const track = clip.tracks[bone.id];
      const clipRot = track ? sampleTrack(track, t) : ZERO_ROT;

      const cur = result.get(bone.id)!;

      if (layer.blend === "additive") {
        result.set(bone.id, {
          x: cur.x + clipRot.x * w,
          y: cur.y + clipRot.y * w,
          z: cur.z + clipRot.z * w,
        });
      } else {
        // override: lerp from current accumulated pose to this layer's pose
        result.set(bone.id, {
          x: cur.x + (clipRot.x - cur.x) * w,
          y: cur.y + (clipRot.y - cur.y) * w,
          z: cur.z + (clipRot.z - cur.z) * w,
        });
      }
    }
  }

  return result;
}

// ---- internal helpers ----

const ZERO_ROT: BoneRotation = { x: 0, y: 0, z: 0 };

/**
 * Sample an animation track at normalized time t ∈ [0, 1].
 * Linearly interpolates between adjacent keyframes.
 * Keyframes must be sorted by ascending `time`.
 */
function sampleTrack(track: AnimationKeyframe[], t: number): BoneRotation {
  if (track.length === 0) return ZERO_ROT;
  if (track.length === 1) return { x: track[0].rotX, y: track[0].rotY, z: track[0].rotZ };

  const tc = Math.max(0, Math.min(1, t));

  // Fast-path: before first or after last keyframe.
  if (tc <= track[0].time) return { x: track[0].rotX, y: track[0].rotY, z: track[0].rotZ };
  const last = track[track.length - 1];
  if (tc >= last.time) return { x: last.rotX, y: last.rotY, z: last.rotZ };

  // Binary search for the interval containing tc.
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (track[mid].time <= tc) lo = mid;
    else hi = mid;
  }

  const a = track[lo];
  const b = track[hi];
  const span = b.time - a.time;
  const alpha = span > 1e-9 ? (tc - a.time) / span : 0;

  return {
    x: a.rotX + (b.rotX - a.rotX) * alpha,
    y: a.rotY + (b.rotY - a.rotY) * alpha,
    z: a.rotZ + (b.rotZ - a.rotZ) * alpha,
  };
}
