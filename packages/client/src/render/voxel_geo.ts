/**
 * Helpers for building merged voxel geometries as THREE.BufferGeometry.
 *
 * One model node → one displaced unit-box translated to the voxel's centre,
 * with a `voxelCenter` attribute baked in for shaders that need to address
 * voxels as units (e.g. forest canopy fade).  All nodes that share a
 * materialId merge into a single BufferGeometry with one index/attribute
 * pair so each (model × material) combo can be drawn in a single call.
 *
 * The displacement/merge math itself lives in the three-free `voxel_bake.ts`
 * so it can run in a Web Worker (T-067); these helpers wrap the worker's (or
 * the synchronous fallback's) raw arrays into a THREE.BufferGeometry on the
 * main thread.  `InstancePool` and the renderer's static-prop path consume them.
 */

import * as THREE from "three";
import type { ModelDefinition } from "@voxim/content";
import { type BakedMesh, bakeSubModel } from "./voxel_bake.ts";

/**
 * Wrap a set of baked geometry arrays (from `voxel_bake.bakeSubModel`, run on
 * the main thread or transferred from the bake worker) into a THREE geometry.
 */
export function geometryFromBaked(baked: BakedMesh): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  out.setAttribute("position",    new THREE.BufferAttribute(baked.positions,   3));
  out.setAttribute("normal",      new THREE.BufferAttribute(baked.normals,     3));
  out.setAttribute("uv",          new THREE.BufferAttribute(baked.uvs,         2));
  out.setAttribute("voxelCenter", new THREE.BufferAttribute(baked.voxelCenter, 3));
  if (baked.indices.length > 0) out.setIndex(new THREE.BufferAttribute(baked.indices, 1));
  return out;
}

/**
 * Build a single merged BufferGeometry for all voxels of one materialId in a
 * model definition.  Vertex displacement is seeded from local (model-space)
 * position — identical for every instance placed in the world.
 *
 * Synchronous fallback path: the bake math runs inline on the calling thread.
 * The worker path (`bake_pool.ts`) calls `bakeSubModel` off-thread and hands
 * the arrays straight to `geometryFromBaked`.
 */
export function buildSubModelGeo(
  nodes: ModelDefinition["nodes"],
  materialId: number,
  scale: { x: number; y: number; z: number },
): THREE.BufferGeometry {
  return geometryFromBaked(bakeSubModel(nodes, materialId, scale));
}
