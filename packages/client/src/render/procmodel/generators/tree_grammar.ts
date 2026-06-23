/**
 * `tree_grammar` generator (T-285b) — a parametric atom-grammar that emits a
 * tree's `VoxelAtom[]` directly from a seed (no authored model). SPEC L22's
 * stated destination: "No hand-authored 3D models … generated procedurally."
 *
 * Three stages, the PRNG consumed in a FIXED order (trunk height → per-whorl,
 * per-branch jitters → foliage uses a position hash, NOT the rng stream), so the
 * output is deterministic per seed. Because the props are visual-only with no
 * hitbox (harvest is a separate invisible ResourceNode), this order has no
 * server counterpart to stay in lockstep with.
 *
 * Atoms are emitted in MODEL space (x=right, y=forward, z=up — the tree grows in
 * +z) and sized in FULL edge lengths; `bakeVoxels` does the model→three mapping
 * and the whole grim look (edge-ink, flat shading, palette snap, vertexDisp) is
 * inherited downstream for free. Trees float above the terrain lattice (no
 * shared corners), so the default per-voxel displacement mag is correct — no
 * terrain weld needed (contrast TERRAIN_DISP_MAG). See PROCMODEL_PRIMITIVE_PLAN.md.
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
    /** Heights (in trunk voxels) where branch whorls sprout. */
    whorlHeights: number[];
    /** [min,max] branches per whorl. */
    perWhorl: [number, number];
    /** Recursion levels (each branch tip spawns child branches). */
    depth: number;
    /** Tilt off the parent direction, degrees. */
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
    /** [0,1] — per-voxel inclusion probability inside the canopy ellipsoid. */
    density: number;
    material: string;
  };
}

interface Vec3 { x: number; y: number; z: number }
type Rng = () => number;

const DEG = Math.PI / 180;

function norm(v: Vec3): Vec3 {
  const m = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / m, y: v.y / m, z: v.z / m };
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** An orthonormal pair perpendicular to `dir` (for tilting child branches). */
function perpFrame(dir: Vec3): { right: Vec3; up: Vec3 } {
  const seed = Math.abs(dir.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const right = norm(cross(dir, seed));
  const up = cross(dir, right); // unit: dir ⟂ right, both unit
  return { right, up };
}

/** Tilt `dir` by `angle` off itself, at azimuth `az` in its local frame. */
function tilt(dir: Vec3, angle: number, az: number): Vec3 {
  const { right, up } = perpFrame(dir);
  const s = Math.sin(angle), c = Math.cos(angle);
  return norm({
    x: c * dir.x + s * (Math.cos(az) * right.x + Math.sin(az) * up.x),
    y: c * dir.y + s * (Math.cos(az) * right.y + Math.sin(az) * up.y),
    z: c * dir.z + s * (Math.cos(az) * right.z + Math.sin(az) * up.z),
  });
}

/** Deterministic position hash → [0,1), independent of the rng stream. */
function hash3(x: number, y: number, z: number, seed: number): number {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2246822519) + Math.imul(seed, 3266489917)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/**
 * Grow one branch from `origin` along `dir`: a staircase of box atoms, then
 * (while depth remains) child branches off the tip; otherwise the tip is a
 * foliage anchor.
 */
function growBranch(
  atoms: VoxelAtom[], tips: Vec3[], origin: Vec3, dir: Vec3,
  length: number, radius: number, depthLeft: number,
  br: NonNullable<TreeGrammarParams["branches"]>, mat: number, rng: Rng,
): void {
  const steps = Math.max(1, Math.round(length));
  let pos = origin;
  for (let i = 1; i <= steps; i++) {
    pos = { x: origin.x + dir.x * i, y: origin.y + dir.y * i, z: origin.z + dir.z * i };
    const d = Math.max(0.6, 2 * radius);
    atoms.push({ cx: pos.x, cy: pos.y, cz: pos.z, sx: d, sy: d, sz: d, materialId: mat });
  }
  if (depthLeft <= 0) { tips.push(pos); return; }
  const children = 2;
  for (let c = 0; c < children; c++) {
    const az = rng() * Math.PI * 2;
    const angle = (br.angleDeg + (rng() - 0.5) * 2 * br.angleJitterDeg) * DEG;
    growBranch(atoms, tips, pos, tilt(dir, angle, az),
      length * br.lengthDecay, radius * br.radiusDecay, depthLeft - 1, br, mat, rng);
  }
}

/** A canopy ellipsoid of leaf voxels around `center`, gated per-voxel by a
 *  position hash for an organic (non-solid) read. Dedups against `placed`. */
function addFoliage(
  atoms: VoxelAtom[], placed: Set<number>, center: Vec3,
  radius: number, density: number, mat: number, seed: number,
): void {
  const R = Math.ceil(radius);
  const cx = Math.round(center.x), cy = Math.round(center.y), cz = Math.round(center.z);
  for (let dz = -R; dz <= R; dz++) {
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const nx = dx / radius, ny = dy / radius, nz = dz / (radius * 0.85); // flattened → canopy
        if (nx * nx + ny * ny + nz * nz > 1) continue;
        const x = cx + dx, y = cy + dy, z = cz + dz;
        if (hash3(x, y, z, seed) >= density) continue;
        // Cantor-pair-ish key over a bounded local range to dedup overlapping blobs.
        const key = ((x + 512) & 1023) | (((y + 512) & 1023) << 10) | (((z + 512) & 1023) << 20);
        if (placed.has(key)) continue;
        placed.add(key);
        atoms.push({ cx: x + 0.5, cy: y + 0.5, cz: z + 0.5, sx: 1, sy: 1, sz: 1, materialId: mat });
      }
    }
  }
}

export const treeGrammar: Generator = (seed, params, ctx) => {
  const p = params as TreeGrammarParams;
  const rng = makePrng(seed);
  const atoms: VoxelAtom[] = [];
  const trunkMat = ctx.resolveMaterial(p.trunk.material);

  // 1. Trunk — a tapering vertical stack of box atoms (radius → square diameter).
  const [hmin, hmax] = p.trunk.heightRange;
  const h = Math.max(2, Math.round(hmin + rng() * (hmax - hmin)));
  for (let z = 0; z < h; z++) {
    const r = p.trunk.radiusBase * (1 - p.trunk.taper * (z / h));
    const d = Math.max(0.6, 2 * r);
    atoms.push({ cx: 0, cy: 0, cz: z + 0.5, sx: d, sy: d, sz: 1, materialId: trunkMat });
  }

  // 2. Branches — whorls of recursive segment chains; collect leaf-bearing tips.
  const tips: Vec3[] = [];
  if (p.branches) {
    const br = p.branches;
    const branchMat = ctx.resolveMaterial(br.material);
    for (const whorlZ of br.whorlHeights) {
      if (whorlZ >= h) continue; // whorl above the trunk top — no anchor
      const count = Math.max(1, Math.round(br.perWhorl[0] + rng() * (br.perWhorl[1] - br.perWhorl[0])));
      const base = rng() * Math.PI * 2;
      for (let b = 0; b < count; b++) {
        const az = base + (b / count) * Math.PI * 2 + (rng() - 0.5) * 0.5;
        const angle = (br.angleDeg + (rng() - 0.5) * 2 * br.angleJitterDeg) * DEG;
        const dir = tilt({ x: 0, y: 0, z: 1 }, angle, az);
        growBranch(atoms, tips, { x: 0, y: 0, z: whorlZ + 0.5 }, dir,
          br.lengthBase, p.trunk.radiusBase * 0.5, br.depth, br, branchMat, rng);
      }
    }
  }

  // 3. Foliage — a canopy blob at every leaf-bearing tip (or the trunk top if
  //    there were no branches), deduped across overlapping blobs.
  if (p.foliage) {
    const foliageMat = ctx.resolveMaterial(p.foliage.material);
    const placed = new Set<number>();
    const anchors = tips.length > 0 ? tips : [{ x: 0, y: 0, z: h }];
    for (const tip of anchors) {
      addFoliage(atoms, placed, tip, p.foliage.radius, p.foliage.density, foliageMat, seed);
    }
  }

  return atoms;
};
