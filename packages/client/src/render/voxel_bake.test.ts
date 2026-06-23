/**
 * T-067 — the bake worker is only safe to run off-thread if its pure geometry
 * math is byte-for-byte identical to the THREE.BoxGeometry + computeVertexNormals
 * path it replaced.  These tests pin that equality against a live THREE
 * reference, plus the merge bookkeeping.
 */

import { assertEquals } from "jsr:@std/assert";
import * as THREE from "three";
import { vertexDisp } from "./displacement.ts";
import {
  bakeDisplacedVoxel,
  bakeSubModel,
  bakeVoxels,
  BOX_INDEX_COUNT,
  BOX_VERT_COUNT,
  computeVertexNormals,
  unitBoxIndex,
  unitBoxUV,
} from "./voxel_bake.ts";
import type { VoxelAtom } from "@voxim/content";

// ---- THREE reference implementations (the pre-T-067 synchronous path) ----

const REF_BOX = new THREE.BoxGeometry(1, 1, 1);

/** Mirrors the old entity_mesh.buildDisplacedVoxelGeo exactly. */
function refDisplacedVoxel(
  px: number, py: number, pz: number,
  scale: { x: number; y: number; z: number },
): THREE.BufferGeometry {
  const geo = REF_BOX.clone();
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const mag = 0.10 * Math.min(scale.x, scale.y, scale.z);
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i) * scale.x;
    const ly = pos.getY(i) * scale.z;
    const lz = pos.getZ(i) * scale.y;
    const [dx, dy, dz] = vertexDisp(px + lx, py + ly, pz + lz, mag);
    pos.setXYZ(i, lx + dx, ly + dy, lz + dz);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Mirrors the old voxel_geo.buildSubModelGeo + mergeGeos exactly. */
function refSubModel(
  nodes: ReadonlyArray<{ x: number; y: number; z: number; materialId: number }>,
  materialId: number,
  scale: { x: number; y: number; z: number },
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const node of nodes) {
    if (node.materialId !== materialId) continue;
    const px = node.x * scale.x;
    const py = node.z * scale.z;
    const pz = node.y * scale.y;
    const geo = REF_BOX.clone();
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const mag = 0.10 * Math.min(scale.x, scale.y, scale.z);
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i) * scale.x;
      const ly = pos.getY(i) * scale.z;
      const lz = pos.getZ(i) * scale.y;
      const [dx, dy, dz] = vertexDisp(px + lx, py + ly, pz + lz, mag);
      pos.setXYZ(i, lx + dx, ly + dy, lz + dz);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.translate(px, py, pz);
    const centers = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      centers[i * 3] = px;
      centers[i * 3 + 1] = py;
      centers[i * 3 + 2] = pz;
    }
    geo.setAttribute("voxelCenter", new THREE.BufferAttribute(centers, 3));
    parts.push(geo);
  }
  // merge (positions/normals/uv/voxelCenter/indices) — same as old mergeGeos
  let totalV = 0, totalI = 0;
  for (const g of parts) {
    totalV += g.getAttribute("position").count;
    if (g.index) totalI += g.index.count;
  }
  const positions = new Float32Array(totalV * 3);
  const normals = new Float32Array(totalV * 3);
  const uvs = new Float32Array(totalV * 2);
  const centers = new Float32Array(totalV * 3);
  const indices = new Uint32Array(totalI);
  let vOff = 0, iOff = 0;
  for (const g of parts) {
    const pa = g.getAttribute("position") as THREE.BufferAttribute;
    const na = g.getAttribute("normal") as THREE.BufferAttribute;
    const ua = g.getAttribute("uv") as THREE.BufferAttribute;
    const ca = g.getAttribute("voxelCenter") as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) {
      positions[(vOff + i) * 3] = pa.getX(i);
      positions[(vOff + i) * 3 + 1] = pa.getY(i);
      positions[(vOff + i) * 3 + 2] = pa.getZ(i);
      normals[(vOff + i) * 3] = na.getX(i);
      normals[(vOff + i) * 3 + 1] = na.getY(i);
      normals[(vOff + i) * 3 + 2] = na.getZ(i);
      uvs[(vOff + i) * 2] = ua.getX(i);
      uvs[(vOff + i) * 2 + 1] = ua.getY(i);
      centers[(vOff + i) * 3] = ca.getX(i);
      centers[(vOff + i) * 3 + 1] = ca.getY(i);
      centers[(vOff + i) * 3 + 2] = ca.getZ(i);
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) indices[iOff + i] = g.index.getX(i) + vOff;
      iOff += g.index.count;
    }
    vOff += pa.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  out.setAttribute("voxelCenter", new THREE.BufferAttribute(centers, 3));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  for (const g of parts) g.dispose();
  return out;
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  assertEquals(a.length, b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

// ---- tests ----

Deno.test("unit-box template matches THREE.BoxGeometry attributes", () => {
  assertEquals(BOX_VERT_COUNT, REF_BOX.getAttribute("position").count);
  assertEquals(BOX_INDEX_COUNT, REF_BOX.index!.count);
  assertEquals(maxAbsDiff(unitBoxIndex(), REF_BOX.index!.array), 0);
  assertEquals(maxAbsDiff(unitBoxUV(), REF_BOX.getAttribute("uv").array), 0);
});

Deno.test("bakeDisplacedVoxel is byte-identical to the THREE path across a grid", () => {
  const scale = { x: 0.21, y: 0.18, z: 0.25 };
  let worstPos = 0, worstNorm = 0;
  for (let X = -3; X <= 3; X++) {
    for (let Y = -3; Y <= 3; Y++) {
      for (let Z = -3; Z <= 3; Z++) {
        const px = X * scale.x, py = Z * scale.z, pz = Y * scale.y;
        const ref = refDisplacedVoxel(px, py, pz, scale);
        const baked = bakeDisplacedVoxel(px, py, pz, scale);
        worstPos = Math.max(worstPos, maxAbsDiff(ref.getAttribute("position").array, baked.positions));
        worstNorm = Math.max(worstNorm, maxAbsDiff(ref.getAttribute("normal").array, baked.normals));
        ref.dispose();
      }
    }
  }
  // Exact equality — the worker must not drift from the synchronous path.
  assertEquals(worstPos, 0);
  assertEquals(worstNorm, 0);
});

Deno.test("bakeDisplacedVoxel produces 24 verts of position + normal", () => {
  const baked = bakeDisplacedVoxel(1, 2, 3, { x: 0.2, y: 0.2, z: 0.2 });
  assertEquals(baked.positions.length, BOX_VERT_COUNT * 3);
  assertEquals(baked.normals.length, BOX_VERT_COUNT * 3);
});

Deno.test("bakeSubModel merges + tags voxelCenter identically to the THREE path", () => {
  const scale = { x: 0.21, y: 0.18, z: 0.25 };
  const nodes = [
    { x: 0, y: 0, z: 0, materialId: 1 },
    { x: 1, y: 0, z: 0, materialId: 1 },
    { x: 0, y: 1, z: 2, materialId: 1 },
    { x: 2, y: -1, z: 1, materialId: 2 }, // filtered out by material
  ];
  const ref = refSubModel(nodes, 1, scale);
  const baked = bakeSubModel(nodes, 1, scale);

  // 3 matching voxels × 24 verts.
  assertEquals(baked.positions.length / 3, 3 * BOX_VERT_COUNT);
  assertEquals(baked.indices.length, 3 * BOX_INDEX_COUNT);
  assertEquals(maxAbsDiff(ref.getAttribute("position").array, baked.positions), 0);
  assertEquals(maxAbsDiff(ref.getAttribute("normal").array, baked.normals), 0);
  assertEquals(maxAbsDiff(ref.getAttribute("uv").array, baked.uvs), 0);
  assertEquals(maxAbsDiff(ref.getAttribute("voxelCenter").array, baked.voxelCenter), 0);
  assertEquals(maxAbsDiff(ref.index!.array, baked.indices), 0);
  ref.dispose();
});

Deno.test("bakeSubModel with no matching material yields empty arrays", () => {
  const baked = bakeSubModel([{ x: 0, y: 0, z: 0, materialId: 7 }], 1, { x: 1, y: 1, z: 1 });
  assertEquals(baked.positions.length, 0);
  assertEquals(baked.indices.length, 0);
});

Deno.test("computeVertexNormals matches THREE for the merged geometry", () => {
  // Build a 2-voxel indexed mesh, recompute normals both ways, compare.
  const scale = { x: 0.3, y: 0.3, z: 0.3 };
  const nodes = [
    { x: 0, y: 0, z: 0, materialId: 1 },
    { x: 1, y: 1, z: 1, materialId: 1 },
  ];
  const baked = bakeSubModel(nodes, 1, scale);
  const recomputed = new Float32Array(baked.normals.length);
  computeVertexNormals(baked.positions, baked.indices, recomputed);

  const ref = new THREE.BufferGeometry();
  ref.setAttribute("position", new THREE.BufferAttribute(baked.positions.slice(), 3));
  ref.setIndex(new THREE.BufferAttribute(baked.indices.slice(), 1));
  ref.computeVertexNormals();

  assertEquals(maxAbsDiff(ref.getAttribute("normal").array, recomputed), 0);
  ref.dispose();
});

// ---- T-281: bakeVoxels (the one kitchen) ----

Deno.test("bakeVoxels with uniform-size atoms == bakeSubModel (adapter parity)", () => {
  const nodes = [
    { x: 0, y: 0, z: 0, materialId: 1 },
    { x: 1, y: 2, z: 3, materialId: 1 },
    { x: -2, y: 1, z: 0, materialId: 2 },
  ];
  const scale = { x: 1.3, y: 0.7, z: 1.1 };
  const viaSub = bakeSubModel(nodes, 1, scale);
  // Same nodes hand-built as atoms (center grid-scaled, size = entity scale).
  const atoms: VoxelAtom[] = nodes.map((n) => ({
    cx: n.x * scale.x, cy: n.y * scale.y, cz: n.z * scale.z,
    sx: scale.x, sy: scale.y, sz: scale.z, materialId: n.materialId,
  }));
  const viaAtoms = bakeVoxels(atoms, 1);
  assertEquals(maxAbsDiff(viaAtoms.positions, viaSub.positions), 0);
  assertEquals(maxAbsDiff(viaAtoms.normals, viaSub.normals), 0);
  assertEquals(maxAbsDiff(viaAtoms.indices, viaSub.indices), 0);
  assertEquals(maxAbsDiff(viaAtoms.voxelCenter, viaSub.voxelCenter), 0);
});

Deno.test("bakeVoxels honors PER-VOXEL size — different sizes produce different extents", () => {
  // Two atoms, same material, at the same center, different sizes.
  const small = bakeVoxels([{ cx: 0, cy: 0, cz: 0, sx: 0.5, sy: 0.5, sz: 0.5, materialId: 1 }], 1);
  const big = bakeVoxels([{ cx: 0, cy: 0, cz: 0, sx: 2.0, sy: 2.0, sz: 2.0, materialId: 1 }], 1);
  const extent = (m: { positions: Float32Array }) => {
    let max = 0;
    for (const p of m.positions) if (Math.abs(p) > max) max = Math.abs(p);
    return max;
  };
  // The big voxel's half-extent (~1.0 + disp) must clearly exceed the small one's (~0.25 + disp).
  const eSmall = extent(small), eBig = extent(big);
  assertEquals(eBig > eSmall * 2.5, true, `big extent ${eBig} should dwarf small ${eSmall}`);
});

Deno.test("bakeVoxels mixes sizes within one mesh (non-uniform per axis)", () => {
  // A wide-flat voxel next to a tall-thin one — the 'voxels of different sizes' case.
  const mesh = bakeVoxels([
    { cx: 0, cy: 0, cz: 0, sx: 3, sy: 3, sz: 0.2, materialId: 1 },
    { cx: 5, cy: 0, cz: 0, sx: 0.2, sy: 0.2, sz: 3, materialId: 1 },
  ], 1);
  assertEquals(mesh.positions.length, 2 * BOX_VERT_COUNT * 3);
  assertEquals(mesh.indices.length, 2 * BOX_INDEX_COUNT);
});

Deno.test("bakeVoxels constant-mag keeps a shared cliff-edge corner crack-free (T-283)", () => {
  // Two adjacent terrain column boxes at a cliff: a DEEP one (sz=3) and a SHALLOW
  // one (sz=0.25), centers 1 apart in x, both with their TOP face at height h=4.
  // Their boundary face is at three.x=1.0; the two TOP corners of that face
  // coincide at (1.0, 4, 0) and (1.0, 4, 1) — exactly the seam terrain must not crack.
  const deep:    VoxelAtom = { cx: 0.5, cy: 0.5, cz: 2.5,   sx: 1, sy: 1, sz: 3,    materialId: 1 };
  const shallow: VoxelAtom = { cx: 1.5, cy: 0.5, cz: 3.875, sx: 1, sy: 1, sz: 0.25, materialId: 1 };
  const TERRAIN_MAG = 0.10 * 0.25; // = TERRAIN_DISP_MAG (0.10 * HEIGHT_STEP)

  // Count vertices of A that EXACTLY equal some vertex of B (merged positions are
  // already translated to three-world space, so coincidence = shared world corner).
  const countShared = (a: Float32Array, b: Float32Array): number => {
    let n = 0;
    for (let i = 0; i < a.length; i += 3) {
      for (let j = 0; j < b.length; j += 3) {
        if (a[i] === b[j] && a[i + 1] === b[j + 1] && a[i + 2] === b[j + 2]) { n++; break; }
      }
    }
    return n;
  };

  // Constant mag: both boxes displace the shared top corners identically → they
  // stay welded. At least the 2 top corners of the boundary face coincide.
  const aC = bakeVoxels([deep], 1, TERRAIN_MAG);
  const bC = bakeVoxels([shallow], 1, TERRAIN_MAG);
  assertEquals(countShared(aC.positions, bC.positions) >= 2, true, "constant mag must weld the shared cliff-top corners");

  // Default per-voxel mag: deep→0.10*1, shallow→0.10*0.25 differ, so the shared
  // corners displace apart → the seam cracks (this is the bug the override fixes).
  const aD = bakeVoxels([deep], 1);
  const bD = bakeVoxels([shallow], 1);
  assertEquals(countShared(aD.positions, bD.positions), 0, "default per-voxel mag cracks the seam (no shared corner survives)");
});
