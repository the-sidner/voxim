/**
 * Web Worker that bakes voxel geometry off the render thread (T-067).
 *
 * It imports the SAME pure baking function the main-thread fallback uses
 * (`voxel_bake.bakeDisplacedVoxel`) — the geometry math is not forked.  On each
 * `BakeRequest` it bakes every voxel and posts back the raw Float32Arrays using
 * Transferable ArrayBuffers (zero-copy), so the heavy displacement + normal
 * loops for a complex model (5–27+ nodes) no longer stall the frame.
 *
 * THREE objects can't cross the worker boundary; the pool wraps the returned
 * arrays into BufferGeometry on the main thread.
 */

import { bakeDisplacedVoxel } from "./voxel_bake.ts";
import type { BakeRequest, BakeResponse } from "./bake_protocol.ts";

// This module runs as a module Worker (instantiated by bake_pool.ts via
// `new Worker(new URL("./bake_worker.ts", ...), { type: "module" })`).  Deno's
// type-checker sees the default DOM lib here, so `self` is typed as Window;
// narrow it to the worker surface (onmessage + postMessage-with-transfer).
const worker = self as unknown as Worker;

worker.onmessage = (e: MessageEvent<BakeRequest>) => {
  const req = e.data;
  const positions: Float32Array[] = [];
  const normals: Float32Array[] = [];
  for (const v of req.voxels) {
    const baked = bakeDisplacedVoxel(v.px, v.py, v.pz, v.scale);
    positions.push(baked.positions);
    normals.push(baked.normals);
  }
  const res: BakeResponse = { id: req.id, positions, normals };
  // Transfer every backing buffer — zero-copy hand-off to the main thread.
  // Our arrays are always ArrayBuffer-backed (never SharedArrayBuffer).
  const transfer: ArrayBuffer[] = [];
  for (const a of positions) transfer.push(a.buffer as ArrayBuffer);
  for (const a of normals) transfer.push(a.buffer as ArrayBuffer);
  worker.postMessage(res, transfer);
};
