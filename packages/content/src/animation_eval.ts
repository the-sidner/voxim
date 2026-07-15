/**
 * Animation layer evaluator — shared between server (HitboxSystem) and client
 * (skeleton_evaluator.ts).
 *
 * Works in the same coordinate space as skeleton_solver.ts (x=right, y=up, z=-fwd).
 * Bone rotations are Euler XYZ in radians — the format solveSkeleton() expects.
 *
 * Performance notes:
 *   - Pass an `out` map to reuse storage across ticks (zero allocation on the
 *     hot path — the map AND its per-bone BoneRotation objects are reused and
 *     mutated in place; don't retain references to entries across calls).
 *   - ClipIndex / maskIndex are pre-built once by ContentService and passed in as refs.
 *   - Binary search over keyframes is O(log K) per bone per layer.
 */

import type { SkeletonDef, AnimationClip, AnimationLibrary, AnimationLayer, BoneMask, AnimationKeyframe } from "./types.ts";
import type { BoneRotation, Quat } from "./ik_solver.ts";
import { quatFromEulerXYZ, eulerFromQuat, slerpQuat } from "./ik_solver.ts";

/**
 * Build a clip lookup map (clipId → AnimationClip) for an AnimationLibrary.
 * Pre-computed once by ContentService.getClipIndex().
 *
 * Skeletons no longer carry their own `clips` array (T-178); clips live on
 * the per-archetype AnimationLibrary, and ContentService resolves them via
 * `skeleton.archetype` → library.
 */
export function buildClipIndex(lib: AnimationLibrary): ReadonlyMap<string, AnimationClip> {
  return new Map(Object.entries(lib.clips));
}

/**
 * Build a bone mask lookup map for a skeleton (maskId → BoneMask).
 * Pre-computed once by ContentService.getMaskIndex().
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
 * @param clipIndex  Pre-built clip map from ContentService.getClipIndex(skeletonId).
 * @param maskIndex  Pre-built mask map from ContentService.getMaskIndex(skeletonId).
 * @param layers     Ordered animation layer stack, bottom to top.
 * @param out        Optional output map reused across calls — entries for the
 *                   same skeleton's bones are mutated in place (see the
 *                   module's performance notes). A caller that reuses one map
 *                   across DIFFERENT skeletons must clear it on the swap (the
 *                   client does, in clearMeshContent); a bone-count mismatch
 *                   is caught and cleared here as a cheap guard.
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
  if (out && out.size !== skeleton.bones.length) out.clear();

  // Seed every bone with its rest rotation. Bones that no layer's clip
  // animates (e.g. root) must end up here at rest, not at identity — the
  // skeleton def's restRotX/Y/Z encodes bind orientation (root π spin to
  // align Mixamo +Z forward with the renderer's expected forward axis).
  // Without this seed, a clip lacking a "root" track would sample ZERO_ROT
  // and overwrite the bind, leaving the whole rig facing 180° wrong.
  for (const bone of skeleton.bones) {
    const prev = result.get(bone.id);
    if (prev) {
      prev.x = bone.restRotX ?? 0;
      prev.y = bone.restRotY ?? 0;
      prev.z = bone.restRotZ ?? 0;
    } else {
      result.set(bone.id, {
        x: bone.restRotX ?? 0,
        y: bone.restRotY ?? 0,
        z: bone.restRotZ ?? 0,
      });
    }
  }

  for (const layer of layers) {
    if (layer.weight <= 0) continue;

    const clip = clipIndex.get(layer.clipId);
    if (!clip) continue;

    // Resolve bone mask: empty maskId = full body. The Set is built once per
    // BoneMask ever (WeakMap keyed on the def itself), not per layer per call.
    let maskedBones: ReadonlySet<string> | null = null;
    if (layer.maskId) {
      const mask = maskIndex.get(layer.maskId);
      if (mask) maskedBones = maskBoneSet(mask);
    }

    const w = layer.weight;
    const t = layer.time;

    for (const bone of skeleton.bones) {
      // Skip bones not covered by this layer's mask.
      if (maskedBones !== null && !maskedBones.has(bone.id)) continue;

      // Bones the clip doesn't animate retain their current accumulated value
      // (rest pose for the bottom-most layer, prior layer for stacked ones) —
      // a missing track is "no opinion", not "force to zero".
      const track = clip.tracks[bone.id];
      if (!track) continue;
      const clipRot = sampleTrack(track, t, _sampled);

      const cur = result.get(bone.id)!;

      if (layer.blend === "additive") {
        cur.x += clipRot.x * w;
        cur.y += clipRot.y * w;
        cur.z += clipRot.z * w;
      } else {
        // override: slerp from the accumulated pose to this layer's pose by
        // weight (quaternions, not per-component Euler lerp — a partial-weight
        // crossfade between very different poses, e.g. locomotion→swing, would
        // otherwise sweep limbs through garbage). At w=1 this is an exact
        // replace; at w<1 (a layer fading in/out) it's a clean orientation blend.
        if (w >= 0.999) {
          cur.x = clipRot.x;
          cur.y = clipRot.y;
          cur.z = clipRot.z;
        } else {
          const qc = quatFromEulerXYZ(cur.x, cur.y, cur.z, _qCur);
          const ql = quatFromEulerXYZ(clipRot.x, clipRot.y, clipRot.z, _qLayer);
          eulerFromQuat(slerpQuat(qc, ql, w, _qBlend), cur);
        }
      }
    }
  }

  return result;
}

/** Per-BoneMask membership Set, built once ever per mask def. */
const maskSetCache = new WeakMap<BoneMask, ReadonlySet<string>>();
function maskBoneSet(mask: BoneMask): ReadonlySet<string> {
  let s = maskSetCache.get(mask);
  if (!s) {
    s = new Set(mask.boneIds);
    maskSetCache.set(mask, s);
  }
  return s;
}

// ---- internal helpers ----

// Module-level scratch — single-threaded on both server (tick loop) and
// client (render loop); results are consumed/copied before the next call.
const _sampled: BoneRotation = { x: 0, y: 0, z: 0 };
const _qCur:   Quat = { x: 0, y: 0, z: 0, w: 1 };
const _qLayer: Quat = { x: 0, y: 0, z: 0, w: 1 };
const _qBlend: Quat = { x: 0, y: 0, z: 0, w: 1 };
const _qa:     Quat = { x: 0, y: 0, z: 0, w: 1 };
const _qb:     Quat = { x: 0, y: 0, z: 0, w: 1 };
const _qs:     Quat = { x: 0, y: 0, z: 0, w: 1 };

function setRot(out: BoneRotation, x: number, y: number, z: number): BoneRotation {
  out.x = x; out.y = y; out.z = z;
  return out;
}

/**
 * Sample an animation track at normalized time t ∈ [0, 1].
 * Linearly interpolates between adjacent keyframes.
 * Keyframes must be sorted by ascending `time`.
 *
 * @param out  Optional result object written in place (hot-path reuse).
 */
export function sampleTrack(track: AnimationKeyframe[], t: number, out?: BoneRotation): BoneRotation {
  const o = out ?? { x: 0, y: 0, z: 0 };
  if (track.length === 0) return setRot(o, 0, 0, 0);
  if (track.length === 1) return setRot(o, track[0].rotX, track[0].rotY, track[0].rotZ);

  const tc = Math.max(0, Math.min(1, t));

  // Fast-path: before first or after last keyframe.
  if (tc <= track[0].time) return setRot(o, track[0].rotX, track[0].rotY, track[0].rotZ);
  const last = track[track.length - 1];
  if (tc >= last.time) return setRot(o, last.rotX, last.rotY, last.rotZ);

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

  // Slerp via quaternions, NOT per-component Euler lerp. Euler lerp sweeps
  // through garbage orientations whenever a joint rotates a lot or passes near
  // gimbal lock — the Mixamo melee clips do exactly that (e.g. the elbow flips
  // through x,z ≈ ±π mid-slash), which is the "crippled swing / weird rotations"
  // bug. The Euler→quat→Euler round-trip is lossless for the FK: solveSkeleton
  // re-converts to a quaternion, so only the orientation matters.
  const qa = quatFromEulerXYZ(a.rotX, a.rotY, a.rotZ, _qa);
  const qb = quatFromEulerXYZ(b.rotX, b.rotY, b.rotZ, _qb);
  return eulerFromQuat(slerpQuat(qa, qb, alpha, _qs), o);
}
