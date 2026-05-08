/**
 * Animation library — per-archetype clip files in
 * `data/anim_library/{archetype}/`. Folder placement is authoritative:
 * a file at `data/anim_library/biped/idle.json` is a clip with id "idle"
 * for the biped archetype. No `_skeleton` field — the path determines
 * which library it joins.
 *
 * Two file shapes are supported:
 *
 *  - **Plain clip**: same JSON as an inline `AnimationClip`. Loaded as-is.
 *
 *  - **Compound clip**: a recipe (`additive` / `crossfade` / `phase_shift`)
 *    referencing other library clip ids, **baked into a plain clip at content
 *    load**.  The runtime never sees compound clips — `AnimationSystem` and
 *    the bone evaluator stay unchanged.
 *
 * After loading + baking, the result is one `AnimationLibrary` per archetype
 * (T-178). Multiple skeletons sharing an archetype share the same library by
 * reference.
 */

import type { AnimationClip, AnimationKeyframe, AnimationLibrary, SkeletonDef, BoneMask } from "./types.ts";

// ---- file shapes ----

/** A plain clip file in the library — exactly an `AnimationClip`. */
export interface LibraryClipPlain extends AnimationClip {
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
 * Build a single archetype's animation library from its clip files.
 * Plain clips load as-is; compound clips bake against earlier-loaded plain
 * clips (sharing the same archetype). Cycles or missing references throw.
 *
 * Compounds may reference any plain clip in the SAME archetype — they
 * cannot reach across archetypes (a quadruped compound can't reference a
 * biped clip). That's by design: compounds operate on the shape of the
 * skeleton, which is archetype-specific.
 *
 * The "skeleton lookup" parameter is needed because compound baking
 * sometimes needs the bone hierarchy (e.g. mask-aware additive). Pass any
 * one skeleton of the archetype — they all share bone names.
 */
export function buildAnimationLibrary(
  archetype: string,
  files: LibraryClipFile[],
  skeletonForBaking: SkeletonDef | undefined,
): AnimationLibrary {
  // First pass: index plain clips.
  const baked = new Map<string, AnimationClip>();
  for (const f of files) {
    if (!isCompound(f)) {
      baked.set(f.id, stripMeta(f));
    }
  }

  // Second pass: bake compounds, repeating until stable. Cycles and
  // missing references surface as a non-empty `remaining` after the loop.
  const remaining = files.filter(isCompound);
  if (remaining.length > 0 && !skeletonForBaking) {
    throw new Error(`buildAnimationLibrary: archetype "${archetype}" has compound clips but no skeleton was supplied for baking`);
  }
  for (let safety = 0; remaining.length > 0 && safety < 100; safety++) {
    const before = remaining.length;
    for (let i = remaining.length - 1; i >= 0; i--) {
      const c = remaining[i];
      const refs = compoundRefs(c).map((r) => baked.get(r));
      if (refs.some((r) => !r)) continue; // dependency not yet baked
      const result = bakeCompound(c, refs as AnimationClip[], skeletonForBaking!);
      baked.set(c.id, result);
      remaining.splice(i, 1);
    }
    if (remaining.length === before) break;
  }
  if (remaining.length > 0) {
    const ids = remaining.map((r) => r.id).join(", ");
    throw new Error(`buildAnimationLibrary: archetype "${archetype}" has unresolvable compound clip references (cycle or missing source): ${ids}`);
  }

  const clips: Record<string, AnimationClip> = {};
  for (const [id, clip] of baked) clips[id] = clip;
  return { id: archetype, clips };
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
