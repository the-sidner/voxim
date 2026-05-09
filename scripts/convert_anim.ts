/**
 * Convert a glTF/GLB animation into our skeleton's per-bone Euler XYZ clip JSON.
 *
 * Pipeline:
 *   1. Parse GLB with @gltf-transform/core.
 *   2. For each animation channel, find the source bone name and target bone
 *      via the library bone map.  Drop unmapped bones (fingers, twist, etc.).
 *   3. Resample rotation tracks at a fixed timestep (slerp between source
 *      keyframes).  Translation/scale channels are ignored — our format has
 *      no translation tracks; locomotion comes from the entity's velocity.
 *   4. Convert each per-bone quaternion `A` directly to Euler XYZ (radians).
 *      No retargeting math — when our biped's bone tree, positions, and bind
 *      rotations match the source rig (extracted via `scripts/extract_biped.ts`),
 *      the source's parent-local quaternion at every frame IS the bone's
 *      parent-local rotation we want. Applying a delta (`R = A * B^-1`) would
 *      double-correct for the bind we already encoded as restRot.
 *   5. Apply per-bone rest-pose delta (radians, additive) for cosmetic tuning
 *      — only useful when the bone map's source rig differs slightly from
 *      what the biped expects (Quaternius A-pose-vs-T-pose nudges, etc.).
 *
 * Usage:
 *   deno run -A scripts/convert_anim.ts <input.glb> <library> \
 *     [--clip <name>] [--fps 30] [--loop true|false] [--id <clip-id>]
 *
 * Library is the basename of a JSON file in packages/content/data/anim_maps/.
 * If --clip is omitted every animation in the GLB is dumped as a separate
 * clip entry (newline-separated).  Output goes to stdout — paste into the
 * skeleton JSON's "clips" array.
 */

import { NodeIO, Node } from "npm:@gltf-transform/core@4.2";
import { Euler, Quaternion } from "npm:three@0.167.0";

interface BoneMap {
  /** source bone name → target bone name (in our skeleton). */
  bones: Record<string, string>;
  /**
   * Per-target-bone rest-pose delta in our format's Euler XYZ radians.
   * Added to every sampled rotation; eyeball-tune per library by viewing
   * the imported clip and adjusting until idle/walk look natural.
   */
  restDeltas?: Record<string, [number, number, number]>;
}

interface ClipKeyframe {
  time: number;
  rotX: number;
  rotY: number;
  rotZ: number;
}

interface ClipOutput {
  id: string;
  loop: boolean;
  tracks: Record<string, ClipKeyframe[]>;
}

// ---- CLI ------------------------------------------------------------------

const args = Deno.args;
if (args.length < 2) {
  console.error("usage: convert_anim.ts <input.glb> <library> [--clip name] [--fps 30] [--loop true|false] [--id name]");
  Deno.exit(1);
}
const glbPath = args[0];
const libraryName = args[1];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const wantedClip = flag("--clip");
const fps = parseInt(flag("--fps") ?? "30");
const loopFlag = flag("--loop");
const loop = loopFlag ? loopFlag === "true" : true;
const overrideId = flag("--id");

// ---- Bone map -------------------------------------------------------------

const mapPath = `packages/content/data/anim_maps/${libraryName}.json`;
let map: BoneMap;
try {
  map = JSON.parse(await Deno.readTextFile(mapPath));
} catch (err) {
  console.error(`could not read bone map at ${mapPath}: ${(err as Error).message}`);
  Deno.exit(1);
}

// ---- Parse GLB ------------------------------------------------------------

const io = new NodeIO();
const doc = await io.read(glbPath);
const animations = doc.getRoot().listAnimations();
if (animations.length === 0) {
  console.error(`${glbPath}: no animations`);
  Deno.exit(1);
}

// Build the source scene tree once — we walk it to discover which Mixamo
// bones collapse onto the same biped target (e.g. LeftShoulder + LeftArm →
// upper_arm_l). For each target with multiple mapped sources, we compose
// their per-frame quaternions in tree-order so the target's parent-local
// rotation accounts for every step in the chain.
const nodeByName = new Map<string, Node>();
const parentOf   = new Map<Node, Node | null>();
for (const root of doc.getRoot().listScenes()[0]?.listChildren() ?? []) {
  walkScene(root, null);
}
function walkScene(node: Node, parent: Node | null) {
  nodeByName.set(node.getName(), node);
  parentOf.set(node, parent);
  for (const child of node.listChildren()) walkScene(child, node);
}

// Build target → chain (root-to-leaf source order). For a target with one
// mapped source, the chain is just that source. For a target with multiple,
// the chain walks from the deepest source up while every ancestor also maps
// to the same target — collapsed chain ends when the parent maps elsewhere.
const chainsPerTarget = new Map<string, string[]>();
{
  const sourcesPerTarget = new Map<string, string[]>();
  for (const [src, tgt] of Object.entries(map.bones)) {
    const list = sourcesPerTarget.get(tgt) ?? [];
    list.push(src);
    sourcesPerTarget.set(tgt, list);
  }
  for (const [target, sources] of sourcesPerTarget) {
    // Find the deepest source in the GLB tree. That's the chain's leaf.
    let leaf: string | null = null;
    let leafDepth = -1;
    for (const src of sources) {
      const node = nodeByName.get(src);
      if (!node) continue;
      let depth = 0;
      let cur: Node | null | undefined = parentOf.get(node);
      while (cur) { depth++; cur = parentOf.get(cur); }
      if (depth > leafDepth) { leafDepth = depth; leaf = src; }
    }
    if (!leaf) continue;
    // Walk up from leaf, including ancestors that also map to this target.
    const sourceSet = new Set(sources);
    const chain: string[] = [];
    let cur: Node | null | undefined = nodeByName.get(leaf);
    while (cur && sourceSet.has(cur.getName())) {
      chain.unshift(cur.getName());
      cur = parentOf.get(cur);
    }
    chainsPerTarget.set(target, chain);
  }
}

const clips: ClipOutput[] = [];
for (const anim of animations) {
  const animName = anim.getName() || "anim_unnamed";
  if (wantedClip && animName !== wantedClip) continue;

  // Collect rotation channels per *source* bone (one per Mixamo node).
  type SourceTrack = {
    times: number[];
    quats: [number, number, number, number][];
  };
  const sourceTracks = new Map<string, SourceTrack>();
  let maxTime = 0;

  for (const channel of anim.listChannels()) {
    if (channel.getTargetPath() !== "rotation") continue;
    const node = channel.getTargetNode();
    if (!node) continue;
    const sourceName = node.getName();
    if (!map.bones[sourceName]) continue;

    const sampler = channel.getSampler();
    if (!sampler) continue;
    const inputAcc = sampler.getInput();
    const outputAcc = sampler.getOutput();
    if (!inputAcc || !outputAcc) continue;
    const times = Array.from(inputAcc.getArray() ?? []);
    const flat = outputAcc.getArray();
    if (!flat) continue;

    const quats: [number, number, number, number][] = [];
    for (let i = 0; i < times.length; i++) {
      quats.push([flat[i * 4], flat[i * 4 + 1], flat[i * 4 + 2], flat[i * 4 + 3]]);
      if (times[i] > maxTime) maxTime = times[i];
    }
    sourceTracks.set(sourceName, { times, quats });
  }

  if (sourceTracks.size === 0) {
    console.error(`warning: ${animName} has no rotation channels matching the bone map`);
    continue;
  }
  if (maxTime <= 0) {
    console.error(`warning: ${animName} has zero duration`);
    continue;
  }

  // Resample at fixed fps. Number of samples covers the full duration; the
  // last sample falls at maxTime so a looping source's t=duration repeats t=0.
  const numSamples = Math.max(2, Math.round(maxTime * fps) + 1);
  const tracks: Record<string, ClipKeyframe[]> = {};
  const tmpQuat = new Quaternion();
  const tmpAcc  = new Quaternion();
  const tmpEuler = new Euler();

  for (const [target, chain] of chainsPerTarget) {
    const restDelta = map.restDeltas?.[target] ?? [0, 0, 0];
    const out: ClipKeyframe[] = [];
    // For each chain bone, look up its bind quat (used as constant when no
    // animation channel exists for that bone) and animation track if any.
    const chainData = chain.map((src) => {
      const node = nodeByName.get(src);
      const bind = node ? node.getRotation() as [number, number, number, number] : [0, 0, 0, 1] as [number, number, number, number];
      const track = sourceTracks.get(src) ?? null;
      return { src, bind, track };
    });
    for (let i = 0; i < numSamples; i++) {
      const tNorm = i / (numSamples - 1);
      const tSec = tNorm * maxTime;
      // Compose chain quats in tree order: outer (closer to root) ×
      // ... × inner (target). This produces the parent-local rotation of
      // our biped's collapsed bone — equivalent to Mixamo's recursive FK
      // through the collapsed sub-tree.
      tmpAcc.set(0, 0, 0, 1);
      for (const cd of chainData) {
        if (cd.track) {
          const q = sampleQuat(cd.track.times, cd.track.quats, tSec);
          tmpQuat.set(q[0], q[1], q[2], q[3]);
        } else {
          tmpQuat.set(cd.bind[0], cd.bind[1], cd.bind[2], cd.bind[3]);
        }
        tmpAcc.multiply(tmpQuat);
      }
      tmpEuler.setFromQuaternion(tmpAcc, "XYZ");
      out.push({
        time: round(tNorm, 4),
        rotX: round(tmpEuler.x + restDelta[0], 4),
        rotY: round(tmpEuler.y + restDelta[1], 4),
        rotZ: round(tmpEuler.z + restDelta[2], 4),
      });
    }
    // Skip emitting tracks for targets whose chain had no animation at all
    // (nothing in the chain has a track). Otherwise the output bloats with
    // constant-bind tracks for static bones.
    if (chainData.some((cd) => cd.track !== null)) {
      tracks[target] = out;
    }
  }

  clips.push({
    id: overrideId ?? animName,
    loop,
    tracks,
  });
}

if (clips.length === 0) {
  console.error("no clips produced");
  Deno.exit(1);
}

// Pretty-print as one or more clip objects, ready to splice into a skeleton's
// "clips" array. Comma-separate so the array becomes valid JSON when wrapped.
console.log(clips.map((c) => JSON.stringify(c, null, 2)).join(",\n"));

// ---- Helpers --------------------------------------------------------------

function sampleQuat(
  times: readonly number[],
  quats: readonly [number, number, number, number][],
  t: number,
): [number, number, number, number] {
  if (t <= times[0]) return quats[0];
  const last = times.length - 1;
  if (t >= times[last]) return quats[last];
  // Linear search — keyframe counts per track are typically <100; binary
  // search is overkill and adds bug surface for marginal gain.
  let i = 0;
  while (i < last && times[i + 1] < t) i++;
  const t0 = times[i], t1 = times[i + 1];
  const alpha = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  return slerp(quats[i], quats[i + 1], alpha);
}

function slerp(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number,
): [number, number, number, number] {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  if (dot > 0.9995) {
    const r: [number, number, number, number] = [
      a[0] + (bx - a[0]) * t,
      a[1] + (by - a[1]) * t,
      a[2] + (bz - a[2]) * t,
      a[3] + (bw - a[3]) * t,
    ];
    const n = Math.hypot(r[0], r[1], r[2], r[3]);
    return [r[0] / n, r[1] / n, r[2] / n, r[3] / n];
  }
  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const w0 = Math.sin((1 - t) * theta) / sinTheta;
  const w1 = Math.sin(t * theta) / sinTheta;
  return [
    a[0] * w0 + bx * w1,
    a[1] * w0 + by * w1,
    a[2] * w0 + bz * w1,
    a[3] * w0 + bw * w1,
  ];
}

function round(x: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}
