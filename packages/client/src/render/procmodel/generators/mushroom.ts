/**
 * `mushroom` generator — a tiny stem + a domed cap (T-310 level pass). A spot of
 * colour on the forest floor: a pale 1×1 stem and a flat-ish round cap one voxel
 * taller in the centre. Deterministic per seed; emits in MODEL space.
 */
import type { VoxelAtom } from "@voxim/content";
import { makePrng } from "@voxim/content";
import type { Generator } from "../registry.ts";

export interface MushroomParams {
  /** [min,max] cap radius in voxels. */
  capRadius: [number, number];
  /** [min,max] stem height in voxels. */
  stemHeight: [number, number];
  /** Cap material NAME. */
  capMaterial: string;
  /** Stem material NAME. */
  stemMaterial: string;
}

export const mushroom: Generator = (seed, params, ctx) => {
  const p = params as MushroomParams;
  const rng = makePrng(seed);
  const capMat = ctx.resolveMaterial(p.capMaterial);
  const stemMat = ctx.resolveMaterial(p.stemMaterial);
  const stemH = Math.max(1, Math.round(p.stemHeight[0] + rng() * (p.stemHeight[1] - p.stemHeight[0])));
  const r = Math.max(1, Math.round(p.capRadius[0] + rng() * (p.capRadius[1] - p.capRadius[0])));

  const atoms: VoxelAtom[] = [];
  for (let z = 0; z < stemH; z++) {
    atoms.push({ cx: 0.5, cy: 0.5, cz: z + 0.5, sx: 1, sy: 1, sz: 1, materialId: stemMat });
  }
  const capZ = stemH;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      atoms.push({ cx: dx + 0.5, cy: dy + 0.5, cz: capZ + 0.5, sx: 1, sy: 1, sz: 1, materialId: capMat });
      // Dome: the inner cap rises one more voxel so it reads rounded, not a slab.
      if (d2 <= (r - 1) * (r - 1)) {
        atoms.push({ cx: dx + 0.5, cy: dy + 0.5, cz: capZ + 1 + 0.5, sx: 1, sy: 1, sz: 1, materialId: capMat });
      }
    }
  }
  return atoms;
};
