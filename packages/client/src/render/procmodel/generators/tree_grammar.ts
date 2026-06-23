/**
 * `tree_grammar` generator (T-285) — a parametric atom-grammar that emits a
 * tree's `VoxelAtom[]` directly from a seed (no authored model). SPEC L22's
 * stated destination: "No hand-authored 3D models … generated procedurally."
 *
 * T-285a STUB: emits a plain trunk column so the registry + cross-check + bake
 * path are wired and inert. T-285b replaces this body with the full
 * trunk-taper / branch-L-system / foliage-blob grammar.
 */
import type { VoxelAtom } from "@voxim/content";
import { makePrng } from "@voxim/content";
import type { Generator } from "../registry.ts";

export interface TreeGrammarParams {
  trunk: {
    /** [min,max] trunk height in voxels. */
    heightRange: [number, number];
    radiusBase: number;
    taper: number;
    /** Material NAME (resolved via ctx.resolveMaterial). */
    material: string;
  };
  branches?: {
    whorlHeights: number[];
    perWhorl: [number, number];
    depth: number;
    angleDeg: number;
    angleJitterDeg: number;
    lengthBase: number;
    lengthDecay: number;
    radiusDecay: number;
    material: string;
  };
  foliage?: {
    style: string;
    radius: number;
    density: number;
    material: string;
  };
}

export const treeGrammar: Generator = (seed, params, ctx) => {
  const p = params as TreeGrammarParams;
  const rng = makePrng(seed);
  const trunkMat = ctx.resolveMaterial(p.trunk.material);

  const [hmin, hmax] = p.trunk.heightRange;
  const h = Math.max(1, Math.round(hmin + rng() * (hmax - hmin)));

  // STUB body — a 1×1 column of `h` voxels. Sized in FULL edge lengths
  // (sx=1 spans one unit). The real grammar (T-285b) tapers the trunk and adds
  // branches + foliage; this proves the seed→atoms→bake path end-to-end.
  const atoms: VoxelAtom[] = [];
  for (let z = 0; z < h; z++) {
    atoms.push({ cx: 0, cy: 0, cz: z + 0.5, sx: 1, sy: 1, sz: 1, materialId: trunkMat });
  }
  return atoms;
};
