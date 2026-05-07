/**
 * Animation library — per-skeleton clip files in `data/anim_library/`.
 *
 * Two file shapes are supported:
 *
 *  - **Plain clip**: same JSON as an inline `AnimationClip` plus a `_skeleton`
 *    field naming which skeleton the clip belongs to.  Loaded as-is.
 *
 *  - **Compound clip**: a recipe (`additive` / `crossfade` / `phase_shift`)
 *    referencing other library clip ids, **baked into a plain clip at content
 *    load**.  The runtime never sees compound clips — `AnimationSystem` and
 *    the bone evaluator stay unchanged.
 *
 * After loading + baking, library clips are merged into each `SkeletonDef`'s
 * `clips` array.  A library clip with the same `id` as an inline skeleton clip
 * **overrides** the inline one — that's how the devtool import workflow lets
 * you replace a hand-authored "walk" with an imported Quaternius "walk"
 * without editing the skeleton JSON.
 */

import type { AnimationClip, AnimationKeyframe, SkeletonDef, BoneMask } from "./types.ts";

// ---- file shapes ----

/** A plain clip file in the library — `AnimationClip` + skeleton scope. */
export interface LibraryClipPlain extends AnimationClip {
  /** Which skeleton this clip belongs to.  Required. */
  _skeleton: string;
  /** Optional provenance (e.g. "quaternius:Walking") for the devtool to show. */
  _source?: string;
}

/** Compound clip recipe — baked into a plain clip at content load. */
export type LibraryClipCompound =
  | LibraryAdditiveClip
  | LibraryCrossfadeClip
  | LibraryPhaseShiftClip;

interface CompoundCommon {
  id: string;
  loop: boolean;
  durationSeconds?: number;
  _skeleton: string;
  _source?: string;
}

/** Add `overlay`'s rotations on top of `base`, optionally masked + scaled. */
export interface LibraryAdditiveClip extends CompoundCommon {
  _kind: "additive";
  /** Library or skeleton clip id (resolved at bake time). */
  base: string;
  /** Library or skeleton clip id whose rotations are added on top. */
  overlay: string;
  /** Bone mask id from the skeleton; if omitted, full body. */
  mask?: string;
  /** 0..1 weight for the overlay layer.  Defaults to 1. */
  weight?: number;
}

/** Linearly blend `from` and `to` by `weight` (0 = all from, 1 = all to). */
export interface LibraryCrossfadeClip extends CompoundCommon {
  _kind: "crossfade";
  from: string;
  to: string;
  /** 0..1.  Defaults to 0.5. */
  weight?: number;
}

/** Re-time `source` so its t=0 aligns with this clip's t=offset (mod 1). */
export interface LibraryPhaseShiftClip extends CompoundCommon {
  _kind: "phase_shift";
  source: string;
  /** 0..1, fractional cycle to advance.  Defaults to 0.5. */
  offset?: number;
}

export type LibraryClipFile = LibraryClipPlain | LibraryClipCompound;

function isCompound(c: LibraryClipFile): c is LibraryClipCompound {
  return (c as LibraryClipCompound)._kind !== undefined;
}

// ---- merge into skeletons ----

/**
 * After all library files are loaded and compounds baked, splice the resulting
 * plain clips into each skeleton's `clips` array.  Library clips with an id
 * already present on the skeleton override the inline version.
 */
export function mergeLibraryIntoSkeletons(
  skeletons: Map<string, SkeletonDef>,
  libraryFiles: LibraryClipFile[],
): void {
  // Bake compounds: order matters since a compound may reference another
  // compound.  We loop until no progress is made; cycles raise.
  const baked = new Map<string, AnimationClip>();
  const bySkeleton = new Map<string, AnimationClip[]>();

  // First pass: index plain clips by `${_skeleton}:${id}`.
  const plainKey = (s: string, id: string) => `${s}:${id}`;
  for (const f of libraryFiles) {
    if (!isCompound(f)) {
      baked.set(plainKey(f._skeleton, f.id), stripMeta(f));
    }
  }
  // Also seed the index with the skeleton's inline clips so compounds can
  // reference hand-authored clips by id.
  for (const skel of skeletons.values()) {
    for (const c of skel.clips ?? []) {
      const k = plainKey(skel.id, c.id);
      if (!baked.has(k)) baked.set(k, c);
    }
  }

  // Second pass: bake compounds, repeating until stable.
  const remaining = libraryFiles.filter(isCompound);
  for (let safety = 0; remaining.length > 0 && safety < 100; safety++) {
    const before = remaining.length;
    for (let i = remaining.length - 1; i >= 0; i--) {
      const c = remaining[i];
      const skel = skeletons.get(c._skeleton);
      if (!skel) {
        remaining.splice(i, 1);
        console.warn(`anim_library: compound "${c.id}" targets unknown skeleton "${c._skeleton}" — skipped`);
        continue;
      }
      const refs = compoundRefs(c).map((r) => baked.get(plainKey(c._skeleton, r)));
      if (refs.some((r) => !r)) continue; // dependency not yet baked
      const result = bakeCompound(c, refs as AnimationClip[], skel);
      baked.set(plainKey(c._skeleton, c.id), result);
      remaining.splice(i, 1);
    }
    if (remaining.length === before) break;
  }
  if (remaining.length > 0) {
    const ids = remaining.map((r) => r.id).join(", ");
    throw new Error(`anim_library: unresolvable compound clip references (cycle or missing source): ${ids}`);
  }

  // Group baked clips by skeleton.
  for (const [k, clip] of baked) {
    const sep = k.indexOf(":");
    const skId = k.slice(0, sep);
    const arr = bySkeleton.get(skId) ?? [];
    arr.push(clip);
    bySkeleton.set(skId, arr);
  }

  // Merge into each skeleton, library overriding inline.
  for (const skel of skeletons.values()) {
    const lib = bySkeleton.get(skel.id) ?? [];
    if (lib.length === 0) continue;
    const inlineById = new Map<string, AnimationClip>();
    for (const c of skel.clips ?? []) inlineById.set(c.id, c);
    for (const c of lib) inlineById.set(c.id, c); // library wins
    skel.clips = [...inlineById.values()];
  }
}

// ---- baking ----

function compoundRefs(c: LibraryClipCompound): string[] {
  switch (c._kind) {
    case "additive":   return [c.base, c.overlay];
    case "crossfade":  return [c.from, c.to];
    case "phase_shift":return [c.source];
  }
}

const SAMPLE_FPS = 30;

function bakeCompound(
  c: LibraryClipCompound,
  refs: AnimationClip[],
  skel: SkeletonDef,
): AnimationClip {
  const dur = c.durationSeconds ?? maxDuration(refs);
  const numSamples = Math.max(2, Math.round(dur * SAMPLE_FPS) + 1);

  // Collect all bones touched by any reference.
  const allBones = new Set<string>();
  for (const ref of refs) for (const b of Object.keys(ref.tracks)) allBones.add(b);

  // For additive: optional mask scopes the overlay.
  let maskBones: Set<string> | null = null;
  if (c._kind === "additive" && c.mask) {
    const m: BoneMask | undefined = (skel.boneMasks ?? []).find((m) => m.id === c.mask);
    if (m) maskBones = new Set(m.boneIds);
  }

  const tracks: Record<string, AnimationKeyframe[]> = {};
  for (let i = 0; i < numSamples; i++) {
    const t = i / (numSamples - 1);
    const samples = sampleAt(c, refs, t, allBones, maskBones);
    for (const [bone, [rx, ry, rz]] of samples) {
      (tracks[bone] ??= []).push({
        time: round(t, 4),
        rotX: round(rx, 4),
        rotY: round(ry, 4),
        rotZ: round(rz, 4),
      });
    }
  }

  return {
    id: c.id,
    loop: c.loop,
    durationSeconds: dur,
    tracks,
  };
}

function sampleAt(
  c: LibraryClipCompound,
  refs: AnimationClip[],
  t: number,
  allBones: Set<string>,
  maskBones: Set<string> | null,
): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();

  if (c._kind === "additive") {
    const [base, overlay] = refs;
    const w = c.weight ?? 1;
    for (const bone of allBones) {
      const b = sampleClipAtBone(base, bone, t);
      const masked = maskBones && !maskBones.has(bone);
      if (masked) {
        out.set(bone, b);
      } else {
        const o = sampleClipAtBone(overlay, bone, t);
        out.set(bone, [b[0] + o[0] * w, b[1] + o[1] * w, b[2] + o[2] * w]);
      }
    }
  } else if (c._kind === "crossfade") {
    const [from, to] = refs;
    const w = c.weight ?? 0.5;
    for (const bone of allBones) {
      const a = sampleClipAtBone(from, bone, t);
      const b = sampleClipAtBone(to, bone, t);
      out.set(bone, [
        a[0] + (b[0] - a[0]) * w,
        a[1] + (b[1] - a[1]) * w,
        a[2] + (b[2] - a[2]) * w,
      ]);
    }
  } else {
    const [src] = refs;
    const offset = c.offset ?? 0.5;
    const shifted = ((t + offset) % 1 + 1) % 1;
    for (const bone of allBones) {
      out.set(bone, sampleClipAtBone(src, bone, shifted));
    }
  }

  return out;
}

function sampleClipAtBone(clip: AnimationClip, bone: string, t: number): [number, number, number] {
  const track = clip.tracks[bone];
  if (!track || track.length === 0) return [0, 0, 0];
  // Inline binary-friendly sampling — keep this self-contained so the loader
  // doesn't pull in the full animation_eval surface.
  if (t <= track[0].time) return [track[0].rotX, track[0].rotY, track[0].rotZ];
  const last = track[track.length - 1];
  if (t >= last.time) return [last.rotX, last.rotY, last.rotZ];
  let i = 0;
  while (i < track.length - 1 && track[i + 1].time < t) i++;
  const a = track[i], b = track[i + 1];
  const span = b.time - a.time;
  const alpha = span > 1e-9 ? (t - a.time) / span : 0;
  return [
    a.rotX + (b.rotX - a.rotX) * alpha,
    a.rotY + (b.rotY - a.rotY) * alpha,
    a.rotZ + (b.rotZ - a.rotZ) * alpha,
  ];
}

function maxDuration(refs: AnimationClip[]): number {
  let m = 0;
  for (const r of refs) if ((r.durationSeconds ?? 1) > m) m = r.durationSeconds ?? 1;
  return m || 1;
}

function stripMeta(p: LibraryClipPlain): AnimationClip {
  return {
    id: p.id,
    loop: p.loop,
    durationSeconds: p.durationSeconds,
    tracks: p.tracks,
  };
}

function round(x: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}
