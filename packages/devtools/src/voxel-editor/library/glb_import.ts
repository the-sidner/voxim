/// <reference lib="dom" />
/**
 * Browser-side GLB animation import.  Mirrors `scripts/convert_anim.ts` but
 * uses three.js (already a client dep) instead of @gltf-transform/core, since
 * GLTFLoader runs natively in the browser.
 *
 * Output is a `LibraryClipPlain` ready to POST to /content/anim_library/.
 */
import * as THREE from "three";
import { GLTFLoader } from "https://esm.sh/three@0.167.0/examples/jsm/loaders/GLTFLoader.js";
import type { AnimationKeyframe } from "@voxim/content";
import type { LibraryClipPlain } from "@voxim/content";

/** Bone-map preset shape — same JSON as `data/anim_maps/*.json`. */
export interface BoneMapPreset {
  /** source bone name → target bone name */
  bones: Record<string, string>;
  /** per-target-bone Euler XYZ delta (radians), additive on every keyframe */
  restDeltas?: Record<string, [number, number, number]>;
}

export interface GLBSummary {
  /** Names of all skeleton nodes in the file. */
  boneNames: string[];
  /** Each animation's name + duration in seconds. */
  animations: { name: string; durationSec: number; trackedBones: string[] }[];
  /** Raw three.js scene + clips kept in memory for follow-up conversions. */
  _gltf: { scene: THREE.Object3D; animations: THREE.AnimationClip[] };
}

/** Parse a GLB ArrayBuffer and return a summary plus the parsed handle. */
export async function parseGLB(buf: ArrayBuffer): Promise<GLBSummary> {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(buf, "", (gltf) => {
      const boneNames: string[] = [];
      gltf.scene.traverse((o) => {
        if (o instanceof THREE.Bone || o instanceof THREE.Object3D) {
          if (o.name && !boneNames.includes(o.name)) boneNames.push(o.name);
        }
      });
      const animations = gltf.animations.map((c) => ({
        name: c.name || "(unnamed)",
        durationSec: c.duration,
        trackedBones: [...new Set(c.tracks.map((t) => t.name.split(".")[0]))],
      }));
      resolve({
        boneNames,
        animations,
        _gltf: { scene: gltf.scene, animations: gltf.animations },
      });
    }, (err) => reject(err));
  });
}

export interface ConvertOpts {
  /** Library clip id to write — also the target output filename. */
  id: string;
  /** Which animation to convert (`name` from GLBSummary.animations). */
  animationName: string;
  /** Skeleton scope this clip targets — used by ContentService.merge. */
  skeleton: string;
  /** Bone map (source → target). */
  map: BoneMapPreset;
  /** Sample rate.  30 fps is plenty for our 20 Hz tick + interpolation. */
  fps: number;
  /** Loop flag stored on the produced clip. */
  loop: boolean;
  /** Provenance string saved on the file. */
  source?: string;
}

/**
 * Convert one GLB animation into a plain library clip.  Sampling at fixed fps
 * + slerp normalises the keyframe density across sources (some sources export
 * at 24 fps, others at 60 — 30 keeps file sizes sane and quality good).
 */
export function convertGLBClip(summary: GLBSummary, opts: ConvertOpts): LibraryClipPlain {
  const clip = summary._gltf.animations.find((c) => (c.name || "(unnamed)") === opts.animationName);
  if (!clip) throw new Error(`animation "${opts.animationName}" not found in GLB`);

  // Group rotation tracks by source bone.
  const sourceTracks = new Map<string, THREE.QuaternionKeyframeTrack>();
  for (const track of clip.tracks) {
    const [boneName, prop] = track.name.split(".");
    if (prop !== "quaternion") continue; // only rotations — drop translation/scale (root motion etc.)
    if (track instanceof THREE.QuaternionKeyframeTrack) {
      sourceTracks.set(boneName, track);
    }
  }

  // Build sampled tracks per TARGET bone name (after remap).
  const dur = clip.duration;
  const numSamples = Math.max(2, Math.round(dur * opts.fps) + 1);
  const tracks: Record<string, AnimationKeyframe[]> = {};

  const tmpQuat = new THREE.Quaternion();
  const tmpEuler = new THREE.Euler();
  const lerpDest = new THREE.Quaternion();

  for (const [sourceName, sourceTrack] of sourceTracks) {
    const targetName = opts.map.bones[sourceName];
    if (!targetName) continue;
    const restDelta = opts.map.restDeltas?.[targetName] ?? [0, 0, 0];

    const out: AnimationKeyframe[] = [];
    for (let i = 0; i < numSamples; i++) {
      const tNorm = i / (numSamples - 1);
      const tSec = tNorm * dur;
      sampleQuatTrack(sourceTrack, tSec, lerpDest);
      tmpQuat.copy(lerpDest);
      tmpEuler.setFromQuaternion(tmpQuat, "XYZ");
      out.push({
        time: round(tNorm, 4),
        rotX: round(tmpEuler.x + restDelta[0], 4),
        rotY: round(tmpEuler.y + restDelta[1], 4),
        rotZ: round(tmpEuler.z + restDelta[2], 4),
      });
    }
    // If multiple source bones map to the same target (e.g. Mixamo's Spine
    // and Spine1 both → torso_mid), the later bone wins — same convention as
    // the CLI converter.
    tracks[targetName] = out;
  }

  return {
    id: opts.id,
    loop: opts.loop,
    durationSeconds: round(dur, 3),
    tracks,
    _skeleton: opts.skeleton,
    _source: opts.source,
  };
}

function sampleQuatTrack(track: THREE.QuaternionKeyframeTrack, t: number, out: THREE.Quaternion): void {
  const times = track.times;
  const values = track.values;
  if (t <= times[0]) {
    out.set(values[0], values[1], values[2], values[3]);
    return;
  }
  const last = times.length - 1;
  if (t >= times[last]) {
    const o = last * 4;
    out.set(values[o], values[o + 1], values[o + 2], values[o + 3]);
    return;
  }
  let i = 0;
  while (i < last && times[i + 1] < t) i++;
  const t0 = times[i], t1 = times[i + 1];
  const alpha = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const o0 = i * 4, o1 = o0 + 4;
  // three.js Quaternion.slerp mutates `this` toward `qb` — use a temp.
  out.set(values[o0], values[o0 + 1], values[o0 + 2], values[o0 + 3]);
  const qb = new THREE.Quaternion(values[o1], values[o1 + 1], values[o1 + 2], values[o1 + 3]);
  out.slerp(qb, alpha);
}

function round(x: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}
