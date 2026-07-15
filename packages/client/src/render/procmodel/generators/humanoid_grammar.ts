/**
 * `humanoid_grammar` generator (T-302) — the first `class: "character"`
 * consumer of the ProcModel substrate (T-301). Emits SOLID torso/head + LIMB
 * arms/legs (DESIGN_LANGUAGE.md §1) by reusing the T-186 Layer 2 body-volume
 * evaluator (`@voxim/content`'s `body_recipe.ts`) — this generator does not
 * reimplement capsule/tapered-box math, it re-hosts the existing evaluator
 * behind the registered-generator + boot-coherence-check substrate.
 *
 * Params name a `skeletonId` (resolved via `ctx.getSkeleton`, T-302's addition
 * to `GeneratorContext`) whose `SkeletonDef.bodyRecipe` supplies the per-bone
 * shape declarations (already authored on `biped.json`). Two shapes come out
 * of the SAME per-bone evaluation:
 *
 *   - `humanoidGrammar` (this file's registered `Generator`) — flattens every
 *     bone's local atoms into MODEL space using the skeleton's REST-pose bone
 *     transforms (`solveSkeleton` + `REST_POSE`, the shared FK solver used by
 *     hitbox derivation), so the standalone generator call the boot check
 *     makes (`gen(seed, params, ctx)`) produces one flat, ground-anchored
 *     `VoxelAtom[]` like every other generator — this is what satisfies
 *     DESIGN_LANGUAGE.md §6 item 4 (root at model-space z≈0) and lets
 *     `crossCheckDesignLanguage` verify it with no skeleton-specific code.
 *   - `humanoidGrammarByBone` — the per-bone `Map<boneId, VoxelAtom[]>` shape
 *     `upgradeToSkeletonModel`/`hitbox_derive.ts` actually consume at render
 *     time (bone-LOCAL atoms, attached under each bone's live Group so
 *     animation poses each part independently — flattening to rest-pose
 *     world space, as the registered generator does, would freeze the body
 *     in a T-pose forever). `entity_mesh_registry.ts` calls this instead of
 *     `evaluateBodyRecipe` directly, so the one evaluator now has exactly one
 *     production call site plus this generator's boot-check-only flatten.
 *
 * Organic surface noise (DESIGN_LANGUAGE.md §2) needs no special-casing here:
 * every atom bakes through the same `bakeVoxels` kitchen as tree/boulder/
 * mushroom, which applies `vertexDisp` (welded, position-hashed corner
 * displacement) by default — a generated body already reads organic without
 * this file adding a bespoke noise pass.
 */
import type { SkeletonDef, VoxelAtom } from "@voxim/content";
import { evaluateBodyRecipe, solveSkeleton, REST_POSE, applyQuat } from "@voxim/content";
import type { Generator, GeneratorContext } from "../registry.ts";

export interface HumanoidGrammarParams {
  /** Skeleton archetype id — resolved via `ctx.getSkeleton`. Must carry a `bodyRecipe`. */
  skeletonId: string;
}

/**
 * Per-bone atoms (bone-LOCAL model space), keyed by boneId — the shape the
 * mesh build / hitbox derivation consume. `morphParams` are the resolved
 * values (store.ts's `resolveMorphParams()` output) for THIS entity instance;
 * pass `{}` for the skeleton's neutral rest recipe.
 */
export function humanoidGrammarByBone(
  skeleton: SkeletonDef,
  morphParams: Readonly<Record<string, number>>,
  resolveMaterial: (name: string) => number,
): Map<string, VoxelAtom[]> {
  if (!skeleton.bodyRecipe) return new Map();
  return evaluateBodyRecipe(skeleton.bodyRecipe, morphParams, resolveMaterial);
}

/**
 * The registered `humanoid_grammar` generator: flattens `humanoidGrammarByBone`'s
 * per-bone atoms into one MODEL-space `VoxelAtom[]` at the skeleton's REST
 * pose, for the boot coherence check and any other flat-atom consumer (e.g. a
 * Studio preview). Uniform scale 1 — the generator has no notion of the
 * entity's spawn-time `modelScale`; that multiplies downstream same as every
 * other model.
 */
export const humanoidGrammar: Generator = (_seed, params, ctx: GeneratorContext) => {
  const p = params as HumanoidGrammarParams;
  const skeleton = ctx.getSkeleton?.(p.skeletonId);
  if (!skeleton) {
    throw new Error(`[humanoid_grammar] unknown skeleton "${p.skeletonId}"`);
  }
  const boneIndex = new Map(skeleton.bones.map((b) => [b.id, b]));
  // Neutral morph scope: every declared morph at multiplier 1.0 (the
  // skeleton's authored rest proportions, not a random per-seed sample) —
  // solveSkeleton with an all-1.0 scope collapses to REST_POSE's plain rest
  // offsets, matching the atoms this scope also produces.
  const neutralMorphs: Record<string, number> = {};
  for (const m of skeleton.morphParams ?? []) neutralMorphs[m.id] = 1.0;
  const boneTransforms = solveSkeleton(skeleton, boneIndex, REST_POSE, 1, neutralMorphs);
  const byBone = humanoidGrammarByBone(skeleton, neutralMorphs, ctx.resolveMaterial);

  const out: VoxelAtom[] = [];
  for (const [boneId, atoms] of byBone) {
    const t = boneTransforms.get(boneId);
    if (!t) continue; // recipe part references a bone missing from the skeleton — cross-checked at boot elsewhere
    for (const a of atoms) {
      // Atom centers are bone-local MODEL space (x=right, y=forward, z=up).
      // Rotate into the bone's rest-pose solver-space orientation, then
      // convert the rotated offset + bone position back to model space
      // (inverse of solveSkeleton's model→solver axis swap: solver x=right,
      // y=up, z=-fwd → model x=right, y=-solverZ, z=solverY).
      const localSolver = { x: a.cx, y: a.cz, z: -a.cy };
      const rotated = applyQuat(localSolver, t.rot);
      const worldSolver = {
        x: t.pos.x + rotated.x,
        y: t.pos.y + rotated.y,
        z: t.pos.z + rotated.z,
      };
      // NOTE: only the atom CENTER is rotated into the bone's world
      // orientation — sx/sy/sz stay axis-aligned to MODEL space rather than
      // rotating with the bone. Fine for this flatten's only two consumers
      // (the boot ground-plane check, which only reads cz, and a possible
      // Studio rest-pose preview): every voxel is still correctly PLACED,
      // only its box axes ignore steep bone rotations (e.g. the ~90° arm/leg
      // rest rotations in biped.json), which reads as slightly axis-skewed
      // cubes on close inspection rather than a hard bug. The live render
      // path (`humanoidGrammarByBone` + `upgradeToSkeletonModel`'s per-bone
      // Group) is unaffected — it never rotates atoms itself, THREE.Group
      // rotation handles it, so this simplification is confined to the
      // flatten-only path.
      out.push({
        ...a,
        cx: worldSolver.x,
        cy: -worldSolver.z,
        cz: worldSolver.y,
      });
    }
  }
  return out;
};
