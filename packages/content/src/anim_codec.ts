/**
 * Binary codec for `AnimationLibrary[]` — used by the bootstrap envelope.
 *
 * Animation data is the dominant cost of the bootstrap blob: 350+ clips with
 * dense per-bone keyframe tracks of f32 rotations. JSON-encoding these inflates
 * each f32 to ~7 ASCII chars, and gzip can't dedupe noisy float text well, so
 * the JSON+gzip envelope blew past the 16 MiB frame cap.
 *
 * Layout (little-endian throughout):
 *
 *   u32  libraryCount
 *   per library:
 *     str    id                       (u16 byteLen + UTF-8)
 *     u16    boneTableSize
 *     str[]  boneTable                (deduped per-library)
 *     u32    clipCount
 *     per clip:
 *       str  id
 *       u8   flags                    bit 0 = loop, bit 1 = hasDuration
 *       f64  durationSeconds          (only if hasDuration)
 *       u16  trackCount
 *       per track:
 *         u16  boneIndex              (into library boneTable)
 *         u32  keyframeCount
 *         f32[keyframeCount * 4]      time, rotX, rotY, rotZ
 *
 * f32 keyframes (16 bytes/frame) replace the JSON `{"time":..,"rotX":..,...}`
 * shape (~50–80 bytes/frame) — typically a 4-6× reduction before any further
 * compression. Bone names are deduped per library so the dominant cost is the
 * raw float payload, which is what we want.
 */

import { WireWriter, WireReader } from "@voxim/codecs";
import type { AnimationLibrary, AnimationClip, AnimationKeyframe } from "./types.ts";

const FLAG_LOOP          = 1 << 0;
const FLAG_HAS_DURATION  = 1 << 1;

export function encodeAnimationLibraries(libs: AnimationLibrary[]): Uint8Array {
  const w = new WireWriter();
  w.writeU32(libs.length);

  for (const lib of libs) {
    w.writeStr(lib.id);

    // Build a per-library bone-name table by walking every track key once.
    const boneIndex = new Map<string, number>();
    for (const clip of Object.values(lib.clips)) {
      for (const boneId of Object.keys(clip.tracks)) {
        if (!boneIndex.has(boneId)) boneIndex.set(boneId, boneIndex.size);
      }
    }
    const boneTable = [...boneIndex.keys()];
    w.writeU16(boneTable.length);
    for (const name of boneTable) w.writeStr(name);

    const clips = Object.values(lib.clips);
    w.writeU32(clips.length);
    for (const clip of clips) {
      w.writeStr(clip.id);
      let flags = 0;
      if (clip.loop) flags |= FLAG_LOOP;
      if (clip.durationSeconds !== undefined) flags |= FLAG_HAS_DURATION;
      w.writeU8(flags);
      if (flags & FLAG_HAS_DURATION) w.writeF64(clip.durationSeconds!);

      const trackEntries = Object.entries(clip.tracks);
      w.writeU16(trackEntries.length);
      for (const [boneId, frames] of trackEntries) {
        const idx = boneIndex.get(boneId)!;
        w.writeU16(idx);
        w.writeU32(frames.length);
        for (const f of frames) {
          w.writeF32(f.time);
          w.writeF32(f.rotX);
          w.writeF32(f.rotY);
          w.writeF32(f.rotZ);
        }
      }
    }
  }

  return w.toBytes();
}

export function decodeAnimationLibraries(blob: Uint8Array): AnimationLibrary[] {
  const r = new WireReader(blob);
  const libCount = r.readU32();
  const libs: AnimationLibrary[] = [];

  for (let li = 0; li < libCount; li++) {
    const libId = r.readStr();

    const boneTableSize = r.readU16();
    const boneTable: string[] = new Array(boneTableSize);
    for (let i = 0; i < boneTableSize; i++) boneTable[i] = r.readStr();

    const clipCount = r.readU32();
    const clips: Record<string, AnimationClip> = {};
    for (let ci = 0; ci < clipCount; ci++) {
      const clipId = r.readStr();
      const flags = r.readU8();
      const loop = (flags & FLAG_LOOP) !== 0;
      const durationSeconds = (flags & FLAG_HAS_DURATION) !== 0 ? r.readF64() : undefined;

      const trackCount = r.readU16();
      const tracks: Record<string, AnimationKeyframe[]> = {};
      for (let ti = 0; ti < trackCount; ti++) {
        const boneIdx = r.readU16();
        const boneId = boneTable[boneIdx];
        const kfCount = r.readU32();
        const frames: AnimationKeyframe[] = new Array(kfCount);
        for (let k = 0; k < kfCount; k++) {
          frames[k] = {
            time: r.readF32(),
            rotX: r.readF32(),
            rotY: r.readF32(),
            rotZ: r.readF32(),
          };
        }
        tracks[boneId] = frames;
      }

      const clip: AnimationClip = { id: clipId, loop, tracks };
      if (durationSeconds !== undefined) clip.durationSeconds = durationSeconds;
      clips[clipId] = clip;
    }

    libs.push({ id: libId, clips });
  }

  return libs;
}
