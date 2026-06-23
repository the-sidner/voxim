/**
 * `boulder_grammar` generator (T-285d) — the SECOND generator, proving the
 * ProcModel primitive generalizes: 6 stone variants drop in as one ScatterDef +
 * this file + one register() call, with ZERO renderer/engine edits (ScatterRenderer
 * already handles any ScatterDef). See PROCMODEL_PRIMITIVE_PLAN.md §T-285d.
 *
 * A boulder is a lumpy, flattened ellipsoid of stone voxels: each candidate cell
 * is included if it falls inside a surface whose radius is perturbed per-position
 * by a hash (the `lumpiness`), so the rock reads irregular, and `flatten` squashes
 * it so it sits low like a boulder rather than a floating sphere. Deterministic
 * per seed; emits in MODEL space, FULL edge lengths — the bake kitchen does the rest.
 */
import type { VoxelAtom } from "@voxim/content";
import { makePrng } from "@voxim/content";
import type { Generator } from "../registry.ts";

export interface BoulderGrammarParams {
  /** [min,max] base radius in voxels. */
  radiusRange: [number, number];
  /** Vertical squash (<1 → flatter/wider, sits low). */
  flatten: number;
  /** [0,1] surface irregularity — how much the radius wobbles per direction. */
  lumpiness: number;
  /** Material NAME (resolved via ctx.resolveMaterial). */
  material: string;
}

/** Deterministic position hash → [0,1), independent of the rng stream. */
function hash3(x: number, y: number, z: number, seed: number): number {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2246822519) + Math.imul(seed, 3266489917)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export const boulderGrammar: Generator = (seed, params, ctx) => {
  const p = params as BoulderGrammarParams;
  const rng = makePrng(seed);
  const mat = ctx.resolveMaterial(p.material);

  const [rmin, rmax] = p.radiusRange;
  const r = rmin + rng() * (rmax - rmin);
  const flatten = Math.max(0.2, p.flatten);
  const lump = Math.max(0, Math.min(1, p.lumpiness));
  const R = Math.ceil(r + 1);

  const atoms: VoxelAtom[] = [];
  for (let dz = -R; dz <= R; dz++) {
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        // Per-direction perturbed surface radius → a lumpy, non-spherical rock.
        const surf = r * (1 - lump * 0.5 + lump * hash3(dx, dy, dz, seed));
        const nx = dx, ny = dy, nz = dz / flatten;
        if (nx * nx + ny * ny + nz * nz > surf * surf) continue;
        // Boulders sit ON the ground: lift so the base rests near z=0.
        atoms.push({ cx: dx + 0.5, cy: dy + 0.5, cz: dz + R * flatten + 0.5, sx: 1, sy: 1, sz: 1, materialId: mat });
      }
    }
  }
  return atoms;
};
