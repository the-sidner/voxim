/**
 * Animation editor state — Preact signals for the animation editor mode.
 *
 * editingSkeleton is a mutable working copy of the skeleton being edited.
 * Mutating helpers (addKeyframe, updateKeyframe, etc.) produce a new SkeletonDef
 * value via signal assignment so reactivity fires correctly.
 */
import { signal, computed } from "@preact/signals";
import type { SkeletonDef, AnimationClip, AnimationKeyframe } from "@voxim/content";

/** The skeleton being edited — deep-cloned from content, mutations go through helpers. */
export const editingSkeleton = signal<SkeletonDef | null>(null);

/** Currently selected clip ID. */
export const editingClipId = signal<string | null>(null);

/** Normalized playhead position [0, 1] over the current clip. */
export const scrubTime = signal<number>(0);

/** True while playback is running. */
export const isPlaying = signal<boolean>(false);

/** Currently selected bone ID (for keyframe editing). */
export const selectedBoneId = signal<string | null>(null);

/** Index of the selected keyframe in selectedBoneId's track. null = none. */
export const selectedKeyframeIdx = signal<number | null>(null);

// ---- computed ----

export const editingClip = computed<AnimationClip | null>(() => {
  const sk = editingSkeleton.value;
  const id = editingClipId.value;
  if (!sk || !id) return null;
  return sk.clips?.find((c) => c.id === id) ?? null;
});

export const selectedBoneKeyframes = computed<AnimationKeyframe[]>(() => {
  const clip = editingClip.value;
  const boneId = selectedBoneId.value;
  if (!clip || !boneId) return [];
  return clip.tracks[boneId] ?? [];
});

export const selectedKeyframe = computed<AnimationKeyframe | null>(() => {
  const kfs = selectedBoneKeyframes.value;
  const idx = selectedKeyframeIdx.value;
  if (idx === null || idx < 0 || idx >= kfs.length) return null;
  return kfs[idx];
});

// ---- helpers ----

function cloneSkeleton(sk: SkeletonDef): SkeletonDef {
  return JSON.parse(JSON.stringify(sk));
}

/** Load a skeleton into the editor. Resets clip/scrub/selection. */
export function loadSkeleton(sk: SkeletonDef): void {
  const copy = cloneSkeleton(sk);
  // Ensure each clip has durationSeconds
  for (const clip of copy.clips ?? []) {
    if (clip.durationSeconds === undefined) clip.durationSeconds = 1.0;
  }
  editingSkeleton.value = copy;
  editingClipId.value = copy.clips?.[0]?.id ?? null;
  scrubTime.value = 0;
  isPlaying.value = false;
  selectedBoneId.value = null;
  selectedKeyframeIdx.value = null;
}

/** Add a new empty clip to the editing skeleton. */
export function addClip(): void {
  const sk = editingSkeleton.value;
  if (!sk) return;
  const next = cloneSkeleton(sk);
  const id = `clip_${Date.now()}`;
  next.clips = [...(next.clips ?? []), { id, loop: true, tracks: {}, durationSeconds: 1.0 }];
  editingSkeleton.value = next;
  editingClipId.value = id;
  scrubTime.value = 0;
  selectedBoneId.value = null;
  selectedKeyframeIdx.value = null;
}

/** Delete a clip by ID. Selects the next available clip. */
export function deleteClip(id: string): void {
  const sk = editingSkeleton.value;
  if (!sk) return;
  const next = cloneSkeleton(sk);
  next.clips = (next.clips ?? []).filter((c) => c.id !== id);
  editingSkeleton.value = next;
  if (editingClipId.value === id) {
    editingClipId.value = next.clips?.[0]?.id ?? null;
    scrubTime.value = 0;
    selectedBoneId.value = null;
    selectedKeyframeIdx.value = null;
  }
}

/** Rename a clip. No-op if newId is already used or empty. */
export function renameClip(oldId: string, newId: string): void {
  const sk = editingSkeleton.value;
  if (!sk || !newId || oldId === newId) return;
  if (sk.clips?.some((c) => c.id === newId)) return;
  const next = cloneSkeleton(sk);
  const clip = next.clips?.find((c) => c.id === oldId);
  if (clip) clip.id = newId;
  editingSkeleton.value = next;
  if (editingClipId.value === oldId) editingClipId.value = newId;
}

export function setClipLoop(id: string, loop: boolean): void {
  const sk = editingSkeleton.value;
  if (!sk) return;
  const next = cloneSkeleton(sk);
  const clip = next.clips?.find((c) => c.id === id);
  if (clip) clip.loop = loop;
  editingSkeleton.value = next;
}

export function setClipDuration(id: string, seconds: number): void {
  const sk = editingSkeleton.value;
  if (!sk) return;
  const next = cloneSkeleton(sk);
  const clip = next.clips?.find((c) => c.id === id);
  if (clip) clip.durationSeconds = Math.max(0.05, seconds);
  editingSkeleton.value = next;
}

/**
 * Add a keyframe for boneId at normalized time t in the editing clip.
 * If a keyframe already exists within ±0.005 of t, it is selected instead.
 * New keyframes inherit the current evaluated rotation (zero for rest pose).
 * Track is kept sorted by time.
 */
export function addKeyframe(boneId: string, t: number, rot = { rotX: 0, rotY: 0, rotZ: 0 }): void {
  const sk = editingSkeleton.value;
  const clipId = editingClipId.value;
  if (!sk || !clipId) return;
  const next = cloneSkeleton(sk);
  const clip = next.clips?.find((c) => c.id === clipId);
  if (!clip) return;
  if (!clip.tracks[boneId]) clip.tracks[boneId] = [];
  const track = clip.tracks[boneId];
  const existing = track.findIndex((kf) => Math.abs(kf.time - t) < 0.005);
  if (existing !== -1) {
    editingSkeleton.value = next;
    selectedBoneId.value = boneId;
    selectedKeyframeIdx.value = existing;
    return;
  }
  const newKf: AnimationKeyframe = { time: t, ...rot };
  track.push(newKf);
  track.sort((a, b) => a.time - b.time);
  editingSkeleton.value = next;
  selectedBoneId.value = boneId;
  selectedKeyframeIdx.value = clip.tracks[boneId].findIndex((kf) => kf.time === newKf.time);
}

/** Update rotation fields on a specific keyframe (by index in the bone track). */
export function updateKeyframeRotation(
  boneId: string,
  idx: number,
  patch: { rotX?: number; rotY?: number; rotZ?: number },
): void {
  const sk = editingSkeleton.value;
  const clipId = editingClipId.value;
  if (!sk || !clipId) return;
  const next = cloneSkeleton(sk);
  const clip = next.clips?.find((c) => c.id === clipId);
  if (!clip) return;
  const track = clip.tracks[boneId];
  if (!track || idx < 0 || idx >= track.length) return;
  Object.assign(track[idx], patch);
  editingSkeleton.value = next;
}

/** Delete a keyframe by index. Clears selection. */
export function deleteKeyframe(boneId: string, idx: number): void {
  const sk = editingSkeleton.value;
  const clipId = editingClipId.value;
  if (!sk || !clipId) return;
  const next = cloneSkeleton(sk);
  const clip = next.clips?.find((c) => c.id === clipId);
  if (!clip || !clip.tracks[boneId]) return;
  clip.tracks[boneId].splice(idx, 1);
  if (clip.tracks[boneId].length === 0) delete clip.tracks[boneId];
  editingSkeleton.value = next;
  selectedKeyframeIdx.value = null;
}

/** Move a keyframe to a new normalized time. Track is re-sorted; selection follows. */
export function moveKeyframeTime(boneId: string, idx: number, newTime: number): void {
  const sk = editingSkeleton.value;
  const clipId = editingClipId.value;
  if (!sk || !clipId) return;
  const next = cloneSkeleton(sk);
  const clip = next.clips?.find((c) => c.id === clipId);
  if (!clip || !clip.tracks[boneId]) return;
  const t = Math.max(0, Math.min(1, newTime));
  const kf = clip.tracks[boneId][idx];
  kf.time = t;
  clip.tracks[boneId].sort((a, b) => a.time - b.time);
  editingSkeleton.value = next;
  selectedKeyframeIdx.value = clip.tracks[boneId].findIndex((k) => k === kf);
}

/** Export the full edited skeleton as JSON. */
export function exportSkeletonJson(): string {
  return JSON.stringify(editingSkeleton.value, null, 2);
}
