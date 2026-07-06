/**
 * `armor_grammar` generator (T-306) — thin ProcModel-registry wrapper over
 * `@voxim/content`'s shared `armorGrammarAtoms` core, the armor twin of
 * `blade_grammar.ts`. Two shapes come out of the SAME per-bone core (the
 * `humanoid_grammar` pattern, T-302):
 *
 *   - `armorGrammar` (this file's registered `Generator`) — flattens EVERY
 *     bone declared in `params.plates` into one MODEL-space `VoxelAtom[]`
 *     using the skeleton's rest-pose bone transforms (via `ctx.getSkeleton`),
 *     for the boot coherence check / a Studio preview. This is the standalone
 *     `(seed, params, ctx) => VoxelAtom[]` shape the registry calls.
 *   - `armorGrammarByBone` — the per-bone `Map<boneId, VoxelAtom[]>` the live
 *     render path (`entity_mesh_registry.ts`'s `syncArmorSlot`) consumes:
 *     bone-LOCAL atoms attached under each bone's live THREE.Group, the SAME
 *     mechanism humanoid_grammar's body atoms and every authored armor piece
 *     already ride, so a generated plate poses with the limb for free.
 *
 * A plate is SHELL (DESIGN_LANGUAGE.md §1) — a thin covering layer over the
 * bone's body-recipe LIMB/SOLID, never a bulk replacement. Not
 * `class: "character"` (armor plates aren't ground-anchored bodies).
 */
import type { SkeletonDef, VoxelAtom, ArmorGrammarParams } from "@voxim/content";
import {
  armorGrammarAtoms, solveSkeleton, REST_POSE, applyQuat,
} from "@voxim/content";
import type { Generator, GeneratorContext } from "../registry.ts";

export type { ArmorGrammarParams };

/** Bone-local segment length from a bone's rest offset (matches
 *  `boneSegmentLength` in entity_mesh.ts — the plate's coverage fraction
 *  works against the limb it covers). */
function boneSegLen(b: SkeletonDef["bones"][number]): number {
  return Math.sqrt(b.restX * b.restX + b.restY * b.restY + b.restZ * b.restZ);
}

/**
 * Per-bone plate atoms (bone-LOCAL model space), keyed by boneId — the shape
 * the live mesh build (`syncArmorSlot`) consumes. Only bones with an authored
 * plate spec AND present on the skeleton produce atoms.
 */
export function armorGrammarByBone(
  seed: number,
  skeleton: SkeletonDef,
  params: ArmorGrammarParams,
  resolveMaterial: (name: string) => number,
): Map<string, VoxelAtom[]> {
  const out = new Map<string, VoxelAtom[]>();
  const boneById = new Map(skeleton.bones.map((b) => [b.id, b]));
  for (const boneId of Object.keys(params.plates)) {
    const bone = boneById.get(boneId);
    if (!bone) continue; // plate names a bone this skeleton lacks — skip (no error, mirrors a missing armor piece)
    const atoms = armorGrammarAtoms(seed, boneId, boneSegLen(bone), params, resolveMaterial);
    if (atoms.length > 0) out.set(boneId, atoms);
  }
  return out;
}

/**
 * Registered `armor_grammar` generator: flattens `armorGrammarByBone`'s
 * per-bone atoms into one MODEL-space `VoxelAtom[]` at the skeleton's REST
 * pose — the boot-check / preview shape. Params must name a `skeletonId`
 * (resolved via `ctx.getSkeleton`, T-302's addition). Same rest-pose flatten
 * math as `humanoid_grammar`'s registered generator (atom CENTER rotated into
 * the bone's rest orientation; box axes stay model-aligned — fine for the
 * flatten's boot-check-only consumer).
 */
export const armorGrammar: Generator = (seed, params, ctx: GeneratorContext) => {
  const p = params as ArmorGrammarParams & { skeletonId?: string };
  if (!p.skeletonId) throw new Error(`[armor_grammar] params missing skeletonId`);
  const skeleton = ctx.getSkeleton?.(p.skeletonId);
  if (!skeleton) throw new Error(`[armor_grammar] unknown skeleton "${p.skeletonId}"`);

  const boneIndex = new Map(skeleton.bones.map((b) => [b.id, b]));
  const neutralMorphs: Record<string, number> = {};
  for (const m of skeleton.morphParams ?? []) neutralMorphs[m.id] = 1.0;
  const boneTransforms = solveSkeleton(skeleton, boneIndex, REST_POSE, 1, neutralMorphs);
  const byBone = armorGrammarByBone(seed, skeleton, p, ctx.resolveMaterial);

  const out: VoxelAtom[] = [];
  for (const [boneId, atoms] of byBone) {
    const t = boneTransforms.get(boneId);
    if (!t) continue;
    for (const a of atoms) {
      // bone-local model (x=right, y=forward, z=up) → solver (x=right, y=up,
      // z=-fwd) → rotate into rest orientation → back to model (same axis
      // swap humanoid_grammar's flatten uses).
      const localSolver = { x: a.cx, y: a.cz, z: -a.cy };
      const rotated = applyQuat(localSolver, t.rot);
      const worldSolver = {
        x: t.pos.x + rotated.x,
        y: t.pos.y + rotated.y,
        z: t.pos.z + rotated.z,
      };
      out.push({ ...a, cx: worldSolver.x, cy: -worldSolver.z, cz: worldSolver.y });
    }
  }
  return out;
};
