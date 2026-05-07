/**
 * Pure-function helpers for building merged voxel geometries.
 *
 * One model node → one displaced unit-box translated to the voxel's centre,
 * with a `voxelCenter` attribute baked in for shaders that need to address
 * voxels as units (e.g. forest canopy fade).  All nodes that share a
 * materialId merge into a single BufferGeometry with one index/attribute
 * pair so each (model × material) combo can be drawn in a single call.
 *
 * The helpers do not own a scene, materials, or instancing — they're the
 * raw geometry kitchen. `InstancePool` and the renderer's static-prop
 * path consume them.
 */

import * as THREE from "three";
import type { ModelDefinition } from "@voxim/content";
import { vertexDisp } from "./displacement.ts";

/**
 * Build a single merged BufferGeometry for all voxels of one materialId in a
 * model definition.  Vertex displacement is seeded from local (model-space)
 * position — identical for every instance placed in the world.
 */
export function buildSubModelGeo(
  nodes: ModelDefinition["nodes"],
  materialId: number,
  scale: { x: number; y: number; z: number },
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  for (const node of nodes) {
    if (node.materialId !== materialId) continue;
    // Three.js space: model(x, y, z) → three(x*sx, z*sz, y*sy)
    const px = node.x * scale.x;
    const py = node.z * scale.z;
    const pz = node.y * scale.y;
    parts.push(buildLocalDispGeo(px, py, pz, scale));
  }

  if (parts.length === 0) return new THREE.BufferGeometry();
  const merged = mergeGeos(parts);
  for (const g of parts) g.dispose();
  return merged;
}

/** One voxel: unit-box scaled to voxel extents, displaced from local position, translated. */
export function buildLocalDispGeo(
  px: number, py: number, pz: number,
  scale: { x: number; y: number; z: number },
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const mag = 0.10 * Math.min(scale.x, scale.y, scale.z);

  for (let i = 0; i < pos.count; i++) {
    // Scale unit-box (±0.5) to voxel extents — coord mapping identical to entity_mesh.ts
    const lx = pos.getX(i) * scale.x;
    const ly = pos.getY(i) * scale.z; // model z=up → three y
    const lz = pos.getZ(i) * scale.y;
    // Seed on LOCAL position — every instance of this sub-model gets the same shape
    const [dx, dy, dz] = vertexDisp(px + lx, py + ly, pz + lz, mag);
    pos.setXYZ(i, lx + dx, ly + dy, lz + dz);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.translate(px, py, pz); // move to voxel center in model space

  // Tag every vertex with the voxel's centre in model space. Shaders that
  // want per-voxel effects (e.g. forest canopy fade that pops voxels in
  // and out as units instead of slicing them mid-face) read this varying
  // instead of the per-fragment world position.
  const vCount = pos.count;
  const centers = new Float32Array(vCount * 3);
  for (let i = 0; i < vCount; i++) {
    centers[i * 3]     = px;
    centers[i * 3 + 1] = py;
    centers[i * 3 + 2] = pz;
  }
  geo.setAttribute("voxelCenter", new THREE.BufferAttribute(centers, 3));

  return geo;
}

export function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0, totalIdx = 0;
  for (const g of geos) {
    totalVerts += g.getAttribute("position").count;
    if (g.index) totalIdx += g.index.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals   = new Float32Array(totalVerts * 3);
  const uvs       = new Float32Array(totalVerts * 2);
  const centers   = new Float32Array(totalVerts * 3);
  const indices   = totalIdx > 0 ? new Uint32Array(totalIdx) : null;

  let vOff = 0, iOff = 0;
  for (const g of geos) {
    const pa = g.getAttribute("position")    as THREE.BufferAttribute;
    const na = g.getAttribute("normal")      as THREE.BufferAttribute;
    const ua = g.getAttribute("uv")          as THREE.BufferAttribute | undefined;
    const ca = g.getAttribute("voxelCenter") as THREE.BufferAttribute | undefined;
    for (let i = 0; i < pa.count; i++) {
      positions[(vOff + i) * 3    ] = pa.getX(i);
      positions[(vOff + i) * 3 + 1] = pa.getY(i);
      positions[(vOff + i) * 3 + 2] = pa.getZ(i);
      normals  [(vOff + i) * 3    ] = na.getX(i);
      normals  [(vOff + i) * 3 + 1] = na.getY(i);
      normals  [(vOff + i) * 3 + 2] = na.getZ(i);
      uvs      [(vOff + i) * 2    ] = ua ? ua.getX(i) : 0;
      uvs      [(vOff + i) * 2 + 1] = ua ? ua.getY(i) : 0;
      centers  [(vOff + i) * 3    ] = ca ? ca.getX(i) : 0;
      centers  [(vOff + i) * 3 + 1] = ca ? ca.getY(i) : 0;
      centers  [(vOff + i) * 3 + 2] = ca ? ca.getZ(i) : 0;
    }
    if (g.index && indices) {
      for (let i = 0; i < g.index.count; i++) {
        indices[iOff + i] = g.index.getX(i) + vOff;
      }
      iOff += g.index.count;
    }
    vOff += pa.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position",    new THREE.BufferAttribute(positions, 3));
  out.setAttribute("normal",      new THREE.BufferAttribute(normals,   3));
  out.setAttribute("uv",          new THREE.BufferAttribute(uvs,       2));
  out.setAttribute("voxelCenter", new THREE.BufferAttribute(centers,   3));
  if (indices) out.setIndex(new THREE.BufferAttribute(indices, 1));
  return out;
}
