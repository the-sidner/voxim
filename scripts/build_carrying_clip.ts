/**
 * Build a one-frame loopable "carrying_idle" clip from the praying pose.
 *
 * Praying already has both arms folded forward at chest height — exactly
 * the silhouette we want for "holding a log against the chest". We copy
 * its first keyframe, widen the elbow fold (less inward) so the hands
 * sit further apart along a horizontal axis, and add a small backward
 * torso lean to suggest the weight of the carried object.
 *
 * Loop = true so the pose holds while the actor walks/idles.
 *
 * Usage:
 *   deno run -A scripts/build_carrying_clip.ts
 */

interface Keyframe {
  time: number;
  rotX: number;
  rotY: number;
  rotZ: number;
}
interface ClipFile {
  id: string;
  loop: boolean;
  tracks: Record<string, Keyframe[]>;
}

const SRC = "packages/content/data/anim_library/biped/praying.json";
const OUT = "packages/content/data/anim_library/biped/carrying_idle.json";

const src = JSON.parse(await Deno.readTextFile(SRC)) as ClipFile;

// Per-bone overrides applied to the praying-frame-0 pose. Only listed
// bones are tweaked; the rest pass through unchanged.
const tweaks: Record<string, Partial<Keyframe>> = {
  // Slight backward torso lean to suggest carrying weight.
  torso_lower: { rotX: -0.18 },
  torso_mid:   { rotX: -0.05 },
  // Widen the elbow fold: praying has rotZ ≈ ±1.85 (hands meet at the
  // midline). Pull back to ±1.45 so hands sit ~30 cm apart at chest
  // level — the natural width to grip a log.
  lower_arm_l: { rotZ: 1.45 },
  lower_arm_r: { rotZ: -1.45 },
  // Hands flat (palm up) to suggest a load resting on them.
  hand_l: { rotX: 0, rotY: 0, rotZ: 0 },
  hand_r: { rotX: 0, rotY: 0, rotZ: 0 },
};

const out: ClipFile = { id: "carrying_idle", loop: true, tracks: {} };

for (const [bone, frames] of Object.entries(src.tracks)) {
  if (frames.length === 0) continue;
  const f0 = frames[0];
  const t = tweaks[bone] ?? {};
  out.tracks[bone] = [
    {
      time: 0,
      rotX: t.rotX ?? f0.rotX,
      rotY: t.rotY ?? f0.rotY,
      rotZ: t.rotZ ?? f0.rotZ,
    },
    // Two identical keyframes so the sampler has an interpolation interval
    // even with loop:true. Some samplers special-case single-frame tracks;
    // this avoids the edge case for a couple of bytes.
    {
      time: 1,
      rotX: t.rotX ?? f0.rotX,
      rotY: t.rotY ?? f0.rotY,
      rotZ: t.rotZ ?? f0.rotZ,
    },
  ];
}

await Deno.writeTextFile(OUT, JSON.stringify(out, null, 2));
console.error(`wrote ${OUT}`);
