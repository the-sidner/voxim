/**
 * Extract a complete biped skeleton (positions + bind rotations + parent
 * relationships) from a Mixamo source FBX/GLB and emit it as a JSON
 * skeleton drop-in for `data/skeletons/biped.json`.
 *
 * Why: Mixamo authors animations against their bone tree, with bone-aligned
 * local axes, specific bone lengths, and non-trivial bind rotations. Our
 * previous biped was eyeballed (round-number positions, identity rest) and
 * structurally wrong (upper_leg_l/r parented to root instead of Hips).
 * That mismatch forced the import to do approximate retargeting (R = A * B^-1).
 *
 * If our biped instead matches Mixamo's source 1:1 — same parents, same
 * positions, same bind rotations — the FK is identical and animations play
 * exactly as authored. The retargeting step disappears.
 *
 * What this script does:
 *   1. Convert FBX → GLB if needed (uses the same FBX2glTF binary the
 *      mixamo-import script fetches).
 *   2. Walk Mixamo's bone tree.
 *   3. For each target bone in our biped, locate the canonical Mixamo source.
 *      When multiple Mixamo bones collapse onto one target (Shoulder + Arm
 *      both → upper_arm_l), accumulate translations and rotations through
 *      the collapsed chain so the target's resting position matches Mixamo's.
 *   4. Convert glTF axes (right=X, up=Y, fwd=-Z) to our entity-local
 *      convention (right=X, fwd=Y, up=Z), scaled to game units.
 *   5. Emit the JSON.
 *
 * Usage:
 *   deno run -A scripts/extract_biped.ts <input.fbx-or-glb> [--scale 0.0156]
 *
 * The --scale converts Mixamo's centimetres to our game units. With our
 * defaultEntityScale of 0.35 baked into ModelRef and the biped offsets
 * eyeballed at ~3 units torso height, a Mixamo ~100cm-Hips translates to
 * ~1.56 units → use scale 0.0156 to keep rough size parity. Tweak after
 * extraction if characters appear too large/small.
 */

import { NodeIO, Document, Node } from "npm:@gltf-transform/core@4.2";
import { Euler, Quaternion, Vector3 } from "npm:three@0.167.0";

// ---- target → canonical Mixamo source ------------------------------------
//
// For each bone in our biped, the SINGLE Mixamo source that becomes the
// authoritative animator and position-source. Mixamo bones above this in
// the same target chain are "collapsed" (their translations and binds are
// accumulated into the target).

interface TargetSpec {
  /** Our biped bone id. */
  target: string;
  /** Our biped parent id. */
  parent: string;
  /** The Mixamo node name we use as the canonical source. */
  source: string;
}

const TARGETS: TargetSpec[] = [
  { target: "torso_lower", parent: "root",        source: "mixamorig:Hips" },
  { target: "torso_mid",   parent: "torso_lower", source: "mixamorig:Spine" },
  { target: "torso_upper", parent: "torso_mid",   source: "mixamorig:Spine1" },
  { target: "head",        parent: "torso_upper", source: "mixamorig:Head" },

  { target: "upper_arm_l", parent: "torso_upper", source: "mixamorig:LeftArm" },
  { target: "lower_arm_l", parent: "upper_arm_l", source: "mixamorig:LeftForeArm" },
  { target: "hand_l",      parent: "lower_arm_l", source: "mixamorig:LeftHand" },

  { target: "upper_arm_r", parent: "torso_upper", source: "mixamorig:RightArm" },
  { target: "lower_arm_r", parent: "upper_arm_r", source: "mixamorig:RightForeArm" },
  { target: "hand_r",      parent: "lower_arm_r", source: "mixamorig:RightHand" },

  // Legs reparented to torso_lower (the bug we're fixing). Mixamo's
  // LeftUpLeg/RightUpLeg are children of Hips → torso_lower in our tree.
  { target: "upper_leg_l", parent: "torso_lower", source: "mixamorig:LeftUpLeg" },
  { target: "lower_leg_l", parent: "upper_leg_l", source: "mixamorig:LeftLeg" },
  { target: "foot_l",      parent: "lower_leg_l", source: "mixamorig:LeftFoot" },

  { target: "upper_leg_r", parent: "torso_lower", source: "mixamorig:RightUpLeg" },
  { target: "lower_leg_r", parent: "upper_leg_r", source: "mixamorig:RightLeg" },
  { target: "foot_r",      parent: "lower_leg_r", source: "mixamorig:RightFoot" },
];

// Bones in any target's collapsed chain that are NOT the canonical source
// but should still be walked over when accumulating from parent_target's
// source down to this target's source.
const COLLAPSED_PARENTS: Record<string, string[]> = {
  // For upper_arm_l (LeftArm), Mixamo's LeftShoulder sits between Spine1 and
  // LeftArm. We accumulate LeftShoulder's translation + bind into upper_arm_l.
  "mixamorig:LeftArm":  ["mixamorig:LeftShoulder"],
  "mixamorig:RightArm": ["mixamorig:RightShoulder"],
  // For head, we may want to include Neck (Mixamo: Hips → ... → Spine1 → Neck → Head).
  "mixamorig:Head":     ["mixamorig:Neck"],
};

// ---- args -----------------------------------------------------------------

const args = Deno.args;
if (args.length < 1) {
  console.error("usage: extract_biped.ts <input.fbx-or-glb> [--scale 0.0156]");
  Deno.exit(1);
}
const inputPath = args[0];
const flag = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const scale = parseFloat(flag("--scale", "0.0156")!);

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
  console.error(`[extract_biped] converting FBX → GLB`);
  const fbx2gltf = await ensureFbx2gltf();
  const tmpStem = "/tmp/extract_biped_tmp";
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

// ---- read GLB -------------------------------------------------------------

const io = new NodeIO();
const doc: Document = await io.read(glbPath);

// Build a name → node map and a child → parent map by walking the scene.
const nodeByName = new Map<string, Node>();
const parentOf   = new Map<Node, Node | null>();
for (const root of doc.getRoot().listScenes()[0]?.listChildren() ?? []) {
  walk(root, null);
}
function walk(node: Node, parent: Node | null) {
  nodeByName.set(node.getName(), node);
  parentOf.set(node, parent);
  for (const child of node.listChildren()) walk(child, node);
}

function nodeBind(name: string): { tx: number; ty: number; tz: number; rx: number; ry: number; rz: number; rw: number } | null {
  const n = nodeByName.get(name);
  if (!n) return null;
  const t = n.getTranslation();
  const r = n.getRotation();
  return { tx: t[0], ty: t[1], tz: t[2], rx: r[0], ry: r[1], rz: r[2], rw: r[3] };
}

// ---- accumulation: parent_source → target_source through collapsed bones --
//
// Target's offset relative to parent_target's source, expressed in
// parent_target's source-local-rotated frame:
//   offset = sum_i(rot_so_far × bone_i.translation)
// Target's restRot relative to parent_target's source:
//   restRot = compose(bone_i.bind for bone_i in chain)

function accumulate(
  parentSource: string,
  targetSource: string,
): { offset: Vector3; rotation: Quaternion } | null {
  // Walk Mixamo tree from target_source upward until we reach parent_source.
  // The chain is in source-tree-order, top-down (so we apply bone[0] first).
  const chain: string[] = [];
  let current = targetSource;
  while (true) {
    chain.unshift(current);
    const node = nodeByName.get(current);
    if (!node) {
      console.error(`[extract_biped] missing source node: ${current}`);
      return null;
    }
    const parent = parentOf.get(node);
    const parentName = parent?.getName();
    if (parentName === parentSource) break;
    if (!parentName) {
      console.error(`[extract_biped] could not reach ${parentSource} walking up from ${targetSource}`);
      return null;
    }
    current = parentName;
  }

  const offset = new Vector3(0, 0, 0);
  const rotation = new Quaternion(0, 0, 0, 1);
  const tmpVec = new Vector3();
  const tmpQuat = new Quaternion();
  for (const boneName of chain) {
    const b = nodeBind(boneName)!;
    // offset += rotation × bone.translation
    tmpVec.set(b.tx, b.ty, b.tz);
    tmpVec.applyQuaternion(rotation);
    offset.add(tmpVec);
    // rotation = rotation × bone.bind
    tmpQuat.set(b.rx, b.ry, b.rz, b.rw);
    rotation.multiply(tmpQuat);
  }
  return { offset, rotation };
}

// ---- emit ------------------------------------------------------------------

interface OutBone {
  id: string;
  parent: string | null;
  restX: number;
  restY: number;
  restZ: number;
  restRotX?: number;
  restRotY?: number;
  restRotZ?: number;
}

const round = (x: number, digits = 4): number => {
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
};

const bones: OutBone[] = [
  { id: "root", parent: null, restX: 0, restY: 0, restZ: 0 },
];

const tmpEuler = new Euler();
for (const t of TARGETS) {
  // For accumulating, we need the parent_target's source. For root → torso_lower,
  // we treat "the scene root above Hips" as parent_source — which means we just
  // use Hips's own translation/rotation directly.
  const parentSpec = TARGETS.find((x) => x.target === t.parent);
  const parentSource = parentSpec?.source ?? null;

  let offset: Vector3, rotation: Quaternion;
  if (parentSource === null) {
    // Root case: use Hips's own translation/rotation.
    const b = nodeBind(t.source);
    if (!b) { console.error(`[extract_biped] missing ${t.source}`); continue; }
    offset = new Vector3(b.tx, b.ty, b.tz);
    rotation = new Quaternion(b.rx, b.ry, b.rz, b.rw);
  } else {
    // Walk from parentSource down to t.source through collapsed chain.
    const acc = accumulate(parentSource, t.source);
    if (!acc) continue;
    offset = acc.offset;
    rotation = acc.rotation;
  }

  // Convert glTF axes (right=X, up=Y, fwd=-Z) to entity-local (right=X, fwd=Y, up=Z).
  // glTF.x = entity.x, glTF.y = entity.z (up), glTF.z = -entity.y (fwd).
  // Then apply game-unit scale.
  const restX = offset.x * scale;
  const restY = -offset.z * scale;
  const restZ = offset.y * scale;

  // Bind rotation: Euler XYZ in solver convention = glTF convention. Solver
  // and entity-local share an axis convention for rotations (rotations are
  // around solver axes), so directly convert quaternion → Euler XYZ.
  tmpEuler.setFromQuaternion(rotation, "XYZ");
  const restRotX = round(tmpEuler.x);
  const restRotY = round(tmpEuler.y);
  const restRotZ = round(tmpEuler.z);

  const out: OutBone = {
    id: t.target,
    parent: t.parent,
    restX: round(restX),
    restY: round(restY),
    restZ: round(restZ),
  };
  // Only emit non-zero rest rotations; zero is the implicit default.
  if (Math.abs(restRotX) > 1e-4) out.restRotX = restRotX;
  if (Math.abs(restRotY) > 1e-4) out.restRotY = restRotY;
  if (Math.abs(restRotZ) > 1e-4) out.restRotZ = restRotZ;
  bones.push(out);
}

// ---- preserve existing biped fields the extractor doesn't touch ------------
//
// boneMasks, ikChains, morphParams are skeleton-design choices not derived
// from the source rig. Read the existing biped.json, splice in the new bones,
// keep the rest.

const bipedPath = "packages/content/data/skeletons/biped.json";
const existing = JSON.parse(await Deno.readTextFile(bipedPath));

const merged = {
  id:        existing.id ?? "biped",
  archetype: existing.archetype ?? "biped",
  bones,
  ...(existing.boneMasks   && { boneMasks:   existing.boneMasks }),
  ...(existing.ikChains    && { ikChains:    existing.ikChains }),
  ...(existing.morphParams && { morphParams: existing.morphParams }),
};

console.log(JSON.stringify(merged, null, 2));
