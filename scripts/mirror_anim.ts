/**
 * Mirror a clip across the body's mid-sagittal plane to produce its
 * left-handed twin (or right-handed, if the source is left-handed).
 *
 * Two transformations:
 *   1. Bone-name swap. *_l ↔ *_r tracks switch tracks. Mid-line bones
 *      (root, torso_*, head) keep their slot.
 *   2. Per-keyframe rotation flip. Mixamo-style XYZ Euler tracks: keep
 *      rotX, negate rotY and rotZ. This mirrors a parent-local rotation
 *      across the YZ plane (the X axis), which is the convention for
 *      Mixamo-derived characters facing +Z with the X axis through the
 *      shoulders. If your character looks visually inverted after running
 *      this, swap the negated-axis set in `flipRotation` — different rigs
 *      sometimes need (negate X, keep Y, keep Z).
 *
 * The mirrored clip's bind orientation differs from a hand-authored
 * left-handed clip by however asymmetric the bind pose is; for Mixamo
 * humanoids that's small enough to look natural in motion. Tune by
 * authoring a clip-level rest delta if needed.
 *
 * Usage:
 *   deno run -A scripts/mirror_anim.ts <input.json> [--out <path>] [--id <clip-id>]
 *
 *   Default output: <input dir>/<clip-id>_mirror.json
 *   Default id:     <input id>_mirror
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

const args = Deno.args;
if (args.length < 1) {
  console.error("usage: mirror_anim.ts <input.json> [--out <path>] [--id <clip-id>]");
  Deno.exit(1);
}

const inPath = args[0];
const flag = (name: string, fallback?: string): string | undefined => {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
};

const raw = await Deno.readTextFile(inPath);
const src = JSON.parse(raw) as ClipFile;
const newId = flag("--id", `${src.id}_mirror`)!;

// Resolve mirror partner for a bone id. Identity for mid-line bones.
function mirrorBone(name: string): string {
  if (name.endsWith("_l")) return name.slice(0, -2) + "_r";
  if (name.endsWith("_r")) return name.slice(0, -2) + "_l";
  return name;
}

function flipRotation(k: Keyframe): Keyframe {
  return { time: k.time, rotX: k.rotX, rotY: -k.rotY, rotZ: -k.rotZ };
}

const outTracks: Record<string, Keyframe[]> = {};
for (const [boneId, frames] of Object.entries(src.tracks)) {
  const targetId = mirrorBone(boneId);
  outTracks[targetId] = frames.map(flipRotation);
}

const out: ClipFile = {
  id: newId,
  loop: src.loop,
  tracks: outTracks,
};

const defaultOut = inPath.replace(/([^/]+)\.json$/, `${newId}.json`);
const outPath = flag("--out", defaultOut)!;
await Deno.writeTextFile(outPath, JSON.stringify(out, null, 2));
console.error(`mirrored ${src.id} → ${newId} → ${outPath}`);
