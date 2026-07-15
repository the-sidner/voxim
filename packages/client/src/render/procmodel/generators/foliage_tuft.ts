/**
 * `foliage_tuft` generator — minimalistic ground cover (T-310 level pass). A
 * cluster of thin upright blades rooted in a small disc; `droop` arcs the tips
 * outward so the same generator makes both straight grass tufts (droop 0) and
 * spreading ferns (droop > 0). Deterministic per seed; emits in MODEL space at
 * full edge lengths — the bake kitchen + palette snap do the rest.
 */
import type { VoxelAtom } from "@voxim/content";
import { makePrng } from "@voxim/content";
import type { Generator } from "../registry.ts";

export interface FoliageTuftParams {
  /** [min,max] blade count. */
  blades: [number, number];
  /** [min,max] blade height in voxels. */
  height: [number, number];
  /** Root scatter radius in voxels (how wide the base spreads). */
  spread: number;
  /** Outward lean of the tip per unit height (0 = upright grass, >0 = fern). */
  droop: number;
  /** Material NAME (resolved via ctx.resolveMaterial). */
  material: string;
}

export const foliageTuft: Generator = (seed, params, ctx) => {
  const p = params as FoliageTuftParams;
  const rng = makePrng(seed);
  const mat = ctx.resolveMaterial(p.material);
  const n = Math.max(1, Math.round(p.blades[0] + rng() * (p.blades[1] - p.blades[0])));
  const atoms: VoxelAtom[] = [];

  for (let b = 0; b < n; b++) {
    const ang = rng() * Math.PI * 2;
    const rootR = rng() * p.spread;
    const rx = Math.cos(ang) * rootR;
    const ry = Math.sin(ang) * rootR;
    const dirx = Math.cos(ang), diry = Math.sin(ang);
    const h = Math.max(1, Math.round(p.height[0] + rng() * (p.height[1] - p.height[0])));
    for (let z = 0; z < h; z++) {
      const t = h > 1 ? z / (h - 1) : 0;          // 0 at base → 1 at tip
      const lean = p.droop * t * t * (0.6 + rootR); // tips arc out (fern), base stays put
      const cx = rx + dirx * lean;
      const cy = ry + diry * lean;
      atoms.push({ cx: cx + 0.5, cy: cy + 0.5, cz: z + 0.5, sx: 1, sy: 1, sz: 1, materialId: mat });
    }
  }
  return atoms;
};
