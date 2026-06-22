/**
 * Message protocol shared by the bake worker (`bake_worker.ts`) and the pool
 * that drives it (`bake_pool.ts`).  T-067 — model geometry baking off the
 * render thread.
 *
 * Only plain data + Transferable ArrayBuffers cross the worker boundary; THREE
 * objects never do.  The pool wraps the returned arrays into BufferGeometry on
 * the main thread.
 */

/** One voxel to bake — model-space Three.js center + the entity scale. */
export interface VoxelBakeSpec {
  px: number;
  py: number;
  pz: number;
  scale: { x: number; y: number; z: number };
}

/** Request: bake a batch of voxels (one model's worth) in a single round-trip. */
export interface BakeRequest {
  /** Correlates the response to the awaiting promise in the pool. */
  id: number;
  voxels: VoxelBakeSpec[];
}

/**
 * Response: per-voxel baked arrays, in the same order as the request's
 * `voxels`.  The backing ArrayBuffers are transferred (zero-copy), so the
 * worker must not touch them after posting.
 */
export interface BakeResponse {
  id: number;
  /** Flat: voxels[i] → { positions, normals }, both Float32Array (24×3). */
  positions: Float32Array[];
  normals: Float32Array[];
}
