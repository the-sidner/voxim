/**
 * Pure, three-free voxel geometry baking.
 *
 * The geometry "kitchen": given voxel node data + an entity scale, produce the
 * raw typed arrays (positions / normals / uvs / voxelCenter / indices) that a
 * THREE.BufferGeometry is built from on the main thread.  No THREE import lives
 * here, so this module is importable from a Web Worker (`bake_worker.ts`) where
 * the baking math runs off the render thread, AND from the synchronous fallback
 * in `entity_mesh.ts` / `voxel_geo.ts` — the *same* functions either way, so the
 * geometry never forks between the two paths.
 *
 * The math mirrors what `THREE.BoxGeometry(1,1,1)` + per-vertex displacement +
 * `geo.computeVertexNormals()` produced before T-067 — the unit-box template
 * positions/index/uv below are the exact attributes THREE emits for a unit box,
 * and `computeVertexNormals` reimplements THREE's face-area-weighted algorithm
 * (BufferGeometry.js) vertex-for-vertex.
 */

import { vertexDisp } from "./displacement.ts";
import type { VoxelAtom } from "@voxim/content";

/** A unit (1×1×1) cube's vertex positions, exactly as THREE.BoxGeometry emits. */
// deno-fmt-ignore
const UNIT_BOX_POSITIONS = new Float32Array([
   0.5,  0.5,  0.5,   0.5,  0.5, -0.5,   0.5, -0.5,  0.5,   0.5, -0.5, -0.5,
  -0.5,  0.5, -0.5,  -0.5,  0.5,  0.5,  -0.5, -0.5, -0.5,  -0.5, -0.5,  0.5,
  -0.5,  0.5, -0.5,   0.5,  0.5, -0.5,  -0.5,  0.5,  0.5,   0.5,  0.5,  0.5,
  -0.5, -0.5,  0.5,   0.5, -0.5,  0.5,  -0.5, -0.5, -0.5,   0.5, -0.5, -0.5,
  -0.5,  0.5,  0.5,   0.5,  0.5,  0.5,  -0.5, -0.5,  0.5,   0.5, -0.5,  0.5,
   0.5,  0.5, -0.5,  -0.5,  0.5, -0.5,   0.5, -0.5, -0.5,  -0.5, -0.5, -0.5,
]);

/** Triangle index list for the unit box (36 indices, 12 tris), as THREE emits. */
// deno-fmt-ignore
const UNIT_BOX_INDEX = new Uint32Array([
   0,  2,  1,   2,  3,  1,   4,  6,  5,   6,  7,  5,
   8, 10,  9,  10, 11,  9,  12, 14, 13,  14, 15, 13,
  16, 18, 17,  18, 19, 17,  20, 22, 21,  22, 23, 21,
]);

/** UV coordinates for the unit box, as THREE emits (2 per vertex, 24 verts). */
// deno-fmt-ignore
const UNIT_BOX_UV = new Float32Array([
  0, 1,  1, 1,  0, 0,  1, 0,
  0, 1,  1, 1,  0, 0,  1, 0,
  0, 1,  1, 1,  0, 0,  1, 0,
  0, 1,  1, 1,  0, 0,  1, 0,
  0, 1,  1, 1,  0, 0,  1, 0,
  0, 1,  1, 1,  0, 0,  1, 0,
]);

/** Vertices per unit box (24). */
export const BOX_VERT_COUNT = UNIT_BOX_POSITIONS.length / 3;
/** Indices per unit box (36). */
export const BOX_INDEX_COUNT = UNIT_BOX_INDEX.length;

/** The shared unit-box index list — every voxel reuses it, offset per merge. */
export function unitBoxIndex(): Uint32Array {
  return UNIT_BOX_INDEX;
}

/** The shared unit-box uv list. */
export function unitBoxUV(): Float32Array {
  return UNIT_BOX_UV;
}

/**
 * Recompute per-vertex normals for an indexed mesh, matching THREE's
 * `BufferGeometry.computeVertexNormals()` exactly: accumulate each face's
 * (pC-pB)×(pA-pB) cross product into its three vertices, then normalize.
 * Writes into `normals` in place.
 */
export function computeVertexNormals(
  positions: Float32Array,
  index: Uint32Array,
  normals: Float32Array,
): void {
  normals.fill(0);
  for (let i = 0; i < index.length; i += 3) {
    const vA = index[i], vB = index[i + 1], vC = index[i + 2];
    const ax = positions[vA * 3], ay = positions[vA * 3 + 1], az = positions[vA * 3 + 2];
    const bx = positions[vB * 3], by = positions[vB * 3 + 1], bz = positions[vB * 3 + 2];
    const cx = positions[vC * 3], cy = positions[vC * 3 + 1], cz = positions[vC * 3 + 2];
    // cb = pC - pB ; ab = pA - pB ; n = cb × ab
    const cbx = cx - bx, cby = cy - by, cbz = cz - bz;
    const abx = ax - bx, aby = ay - by, abz = az - bz;
    const nx = cby * abz - cbz * aby;
    const ny = cbz * abx - cbx * abz;
    const nz = cbx * aby - cby * abx;
    normals[vA * 3]     += nx; normals[vA * 3 + 1] += ny; normals[vA * 3 + 2] += nz;
    normals[vB * 3]     += nx; normals[vB * 3 + 1] += ny; normals[vB * 3 + 2] += nz;
    normals[vC * 3]     += nx; normals[vC * 3 + 1] += ny; normals[vC * 3 + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    let len = Math.sqrt(x * x + y * y + z * z);
    if (len === 0) len = 1;
    normals[i]     = x / len;
    normals[i + 1] = y / len;
    normals[i + 2] = z / len;
  }
}

/** Raw geometry arrays for a single displaced voxel (24 verts, shared index/uv). */
export interface BakedVoxel {
  positions: Float32Array; // 24 × 3, vertex offset NOT applied (local to voxel center)
  normals: Float32Array;   // 24 × 3
}

/**
 * Bake one displaced voxel's local geometry: clone the unit box, scale each
 * ±0.5 vertex to the voxel's Three.js extents, displace it via `vertexDisp`
 * seeded on (px+lx, py+ly, pz+lz), then recompute normals.  Positions are in
 * the voxel's *local* space (origin at the voxel center) — the caller translates
 * to `(px,py,pz)` (the mesh's `position` in entity_mesh, or `geo.translate` in
 * voxel_geo).  This is the array-producing core of `buildDisplacedVoxelGeo` and
 * `buildLocalDispGeo`; the math is byte-for-byte identical.
 */
export function bakeDisplacedVoxel(
  px: number, py: number, pz: number,
  scale: { x: number; y: number; z: number },
): BakedVoxel {
  const positions = new Float32Array(BOX_VERT_COUNT * 3);
  const normals = new Float32Array(BOX_VERT_COUNT * 3);
  const mag = 0.10 * Math.min(scale.x, scale.y, scale.z);
  for (let i = 0; i < BOX_VERT_COUNT; i++) {
    // Scale unit-box (±0.5) to actual voxel extents in Three.js space.
    // Coordinate mapping: model x → three x (scale.x),
    //                     model z=up → three y (scale.z),
    //                     model y=fwd → three z (scale.y).
    const lx = UNIT_BOX_POSITIONS[i * 3]     * scale.x;
    const ly = UNIT_BOX_POSITIONS[i * 3 + 1] * scale.z;
    const lz = UNIT_BOX_POSITIONS[i * 3 + 2] * scale.y;
    const [dx, dy, dz] = vertexDisp(px + lx, py + ly, pz + lz, mag);
    positions[i * 3]     = lx + dx;
    positions[i * 3 + 1] = ly + dy;
    positions[i * 3 + 2] = lz + dz;
  }
  computeVertexNormals(positions, UNIT_BOX_INDEX, normals);
  return { positions, normals };
}

/** Raw geometry arrays for a merged sub-model (one material's voxels). */
export interface BakedMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  voxelCenter: Float32Array;
  indices: Uint32Array;
}

/**
 * THE bake kitchen (T-281): merge every atom of one materialId into a single set
 * of arrays. Each atom is a fully-resolved voxel — `c*` is its CENTER in model
 * space (already grid-scaled), `s*` its PER-VOXEL size (so terrain columns,
 * model nodes, and placed voxels of different sizes all bake through this one
 * path). Center maps model→three (x, z, y); the ±0.5 box scales by the atom's
 * per-axis size. `bakeSubModel` is now a thin nodes→atoms adapter over this, so
 * the merged geometry is byte-identical for uniform sizes (parity-tested).
 */
export function bakeVoxels(
  atoms: ReadonlyArray<VoxelAtom>,
  materialId: number,
): BakedMesh {
  const voxels: { px: number; py: number; pz: number; baked: BakedVoxel }[] = [];
  for (const a of atoms) {
    if (a.materialId !== materialId) continue;
    // model center → three center (x, z, y); size stays in model axes — the
    // displaced-box bake applies the same swap to the extents internally.
    const px = a.cx, py = a.cz, pz = a.cy;
    voxels.push({ px, py, pz, baked: bakeDisplacedVoxel(px, py, pz, { x: a.sx, y: a.sy, z: a.sz }) });
  }

  const vCount = voxels.length * BOX_VERT_COUNT;
  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const uvs = new Float32Array(vCount * 2);
  const voxelCenter = new Float32Array(vCount * 3);
  const indices = new Uint32Array(voxels.length * BOX_INDEX_COUNT);

  let vOff = 0, iOff = 0;
  for (const { px, py, pz, baked } of voxels) {
    for (let i = 0; i < BOX_VERT_COUNT; i++) {
      const v = vOff + i;
      // Translate the voxel's local geometry to its model-space center.
      positions[v * 3]     = baked.positions[i * 3]     + px;
      positions[v * 3 + 1] = baked.positions[i * 3 + 1] + py;
      positions[v * 3 + 2] = baked.positions[i * 3 + 2] + pz;
      normals[v * 3]     = baked.normals[i * 3];
      normals[v * 3 + 1] = baked.normals[i * 3 + 1];
      normals[v * 3 + 2] = baked.normals[i * 3 + 2];
      uvs[v * 2]     = UNIT_BOX_UV[i * 2];
      uvs[v * 2 + 1] = UNIT_BOX_UV[i * 2 + 1];
      voxelCenter[v * 3]     = px;
      voxelCenter[v * 3 + 1] = py;
      voxelCenter[v * 3 + 2] = pz;
    }
    for (let i = 0; i < BOX_INDEX_COUNT; i++) {
      indices[iOff + i] = UNIT_BOX_INDEX[i] + vOff;
    }
    vOff += BOX_VERT_COUNT;
    iOff += BOX_INDEX_COUNT;
  }

  return { positions, normals, uvs, voxelCenter, indices };
}

/**
 * Adapter: bake a model's nodes at one uniform entity `scale` through the atom
 * kitchen. Each node becomes an atom whose center is the grid position scaled
 * into model space and whose size is the entity scale (uniform). Kept so the
 * existing merged-prop path (`voxel_geo.buildSubModelGeo`) is one call away from
 * the unified pipeline; byte-identical to the pre-T-281 bakeSubModel.
 */
export function bakeSubModel(
  nodes: ReadonlyArray<{ x: number; y: number; z: number; materialId: number }>,
  materialId: number,
  scale: { x: number; y: number; z: number },
): BakedMesh {
  const atoms: VoxelAtom[] = nodes.map((n) => ({
    cx: n.x * scale.x, cy: n.y * scale.y, cz: n.z * scale.z,
    sx: scale.x, sy: scale.y, sz: scale.z,
    materialId: n.materialId,
  }));
  return bakeVoxels(atoms, materialId);
}
