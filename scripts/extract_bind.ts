/**
 * Extract source-rig bind-pose rotations from a Mixamo (or other) FBX/GLB
 * and emit them as restRotX/Y/Z patches for the biped skeleton.
 *
 * Why: convert_anim.ts retargets clips with `R = A * B^-1`. That's exact only
 * when the target's restRot matches the source's bind. Our biped currently
 * uses identity restRot (no per-bone bind) — so the retargeting is the
 * "approximation" path the script comment warns about. For Mixamo's
 * non-trivial T-pose binds applied to our identity rest, the approximation
 * shows up as twisted poses on large rotations (windup, swings, hits).
 *
 * Fix: extract the source's per-bone bind quaternions, convert to Euler XYZ,
 * and use them as `restRotX/Y/Z` on `biped.json`. The retargeting then
 * becomes exact (post-multiply cancels source bind, restRot reapplies the
 * same rotation as our target bind).
 *
 * Usage:
 *   deno run -A scripts/extract_bind.ts <input.fbx-or-glb> [--map mixamo] [--out biped]
 *
 * Outputs JSON with two sections:
 *   - bipedPatch: per-bone {restRotX, restRotY, restRotZ} ready to merge into biped.json
 *   - mixamoDeltas: same values formatted as restDeltas for the bone map
 *     (use these if you'd rather re-import all clips with eyeball compensation
 *     instead of changing the skeleton's rest)
 *
 * Coordinate convention is the same as the rest of the engine: glTF / Three.js
 * (right=X, up=Y, fwd=-Z), which matches our solver and clip convention.
 */

import { NodeIO } from "npm:@gltf-transform/core@4.2";
import { Euler, Quaternion } from "npm:three@0.167.0";

interface BoneMap {
  bones: Record<string, string>;
  restDeltas?: Record<string, [number, number, number]>;
}

const args = Deno.args;
if (args.length < 1) {
  console.error("usage: extract_bind.ts <input.fbx-or-glb> [--map mixamo]");
  Deno.exit(1);
}
const inputPath = args[0];
const flag = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const mapName = flag("--map", "mixamo")!;

// ---- ensure GLB -----------------------------------------------------------

async function ensureFbx2gltf(): Promise<string> {
  const binPath = "/tmp/fbx2gltf-bin/package/bin/Linux/FBX2glTF";
  try { await Deno.stat(binPath); return binPath; } catch { /* fetch */ }
  await Deno.mkdir("/tmp/fbx2gltf-bin", { recursive: true });
  const pack = new Deno.Command("npm", {
    args: ["pack", "fbx2gltf", "--silent"],
    cwd: "/tmp/fbx2gltf-bin",
    stdout: "piped", stderr: "inherit",
  });
  const { code, stdout } = await pack.output();
  if (code !== 0) throw new Error("npm pack fbx2gltf failed");
  const tarball = new TextDecoder().decode(stdout).trim();
  const tar = new Deno.Command("tar", {
    args: ["xf", tarball],
    cwd: "/tmp/fbx2gltf-bin",
    stderr: "inherit",
  });
  if ((await tar.output()).code !== 0) throw new Error("tar extract failed");
  await Deno.chmod(binPath, 0o755);
  return binPath;
}

let glbPath = inputPath;
if (inputPath.toLowerCase().endsWith(".fbx")) {
  console.error(`[extract_bind] converting FBX → GLB`);
  const fbx2gltf = await ensureFbx2gltf();
  const tmpStem = "/tmp/extract_bind_tmp";
  glbPath = `${tmpStem}.glb`;
  const cmd = new Deno.Command(fbx2gltf, {
    args: ["-i", inputPath, "-o", tmpStem, "--binary"],
    stdout: "piped", stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    console.error(`FBX2glTF failed: ${new TextDecoder().decode(stderr)}`);
    Deno.exit(1);
  }
}

// ---- bone map -------------------------------------------------------------

const mapPath = `packages/content/data/anim_maps/${mapName}.json`;
const map: BoneMap = JSON.parse(await Deno.readTextFile(mapPath));

// ---- read bind ------------------------------------------------------------

const io = new NodeIO();
const doc = await io.read(glbPath);

// Walk all nodes and collect rotations for nodes whose name appears in the
// bone map. When multiple source bones map to the same target (e.g. clavicle
// + shoulder both → upper_arm_l), we keep them all and let the user pick
// which to use; the final patch uses the first match per target.
type SourceBind = { sourceName: string; quat: [number, number, number, number] };
const bindsPerTarget = new Map<string, SourceBind[]>();

for (const node of doc.getRoot().listNodes()) {
  const sourceName = node.getName();
  const targetName = map.bones[sourceName];
  if (!targetName) continue;
  const q = node.getRotation() as [number, number, number, number];
  const list = bindsPerTarget.get(targetName) ?? [];
  list.push({ sourceName, quat: q });
  bindsPerTarget.set(targetName, list);
}

if (bindsPerTarget.size === 0) {
  console.error("[extract_bind] no mapped nodes found — wrong --map?");
  Deno.exit(1);
}

// ---- emit -----------------------------------------------------------------

const tmpEuler = new Euler();
const tmpQuat = new Quaternion();

interface BipedPatchEntry {
  bone: string;
  source: string;
  restRotX: number;
  restRotY: number;
  restRotZ: number;
}
const patch: BipedPatchEntry[] = [];
const mixamoDeltas: Record<string, [number, number, number]> = {};

const round = (x: number, digits = 4): number => {
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
};

for (const [target, binds] of bindsPerTarget) {
  // Pick the first source mapping. For Mixamo, multiple shoulder/arm bones
  // can map to one target; the bone map's last-wins convention (per
  // convert_anim.ts:142) means the LAST node in the GLB walk is the one
  // contributing during animation. Match that convention here.
  const chosen = binds[binds.length - 1];
  tmpQuat.set(chosen.quat[0], chosen.quat[1], chosen.quat[2], chosen.quat[3]);
  tmpEuler.setFromQuaternion(tmpQuat, "XYZ");
  const e = { x: round(tmpEuler.x), y: round(tmpEuler.y), z: round(tmpEuler.z) };
  patch.push({ bone: target, source: chosen.sourceName, restRotX: e.x, restRotY: e.y, restRotZ: e.z });
  mixamoDeltas[target] = [e.x, e.y, e.z];
}

// Sort patch entries by bone id for deterministic output.
patch.sort((a, b) => a.bone.localeCompare(b.bone));

console.log(JSON.stringify({
  // For path B(i): merge into biped.json's bones[]. Each entry: find the
  // bone with this id and add restRotX/Y/Z fields.
  bipedPatch: patch,

  // For path A: drop into anim_maps/mixamo.json's "restDeltas". These are
  // ADDED to every keyframe Euler at import time — useful for small
  // corrections; less accurate than path B(i) for large bind differences
  // because Euler addition isn't exact rotation composition.
  mixamoDeltas,
}, null, 2));
