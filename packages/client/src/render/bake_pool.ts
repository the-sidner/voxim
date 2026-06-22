/**
 * Client-side worker pool / promise wrapper for voxel geometry baking (T-067).
 *
 * Dispatches a batch of voxels to `bake_worker.ts` and resolves with the baked
 * position/normal arrays.  THREE objects never cross the worker boundary — the
 * caller wraps the arrays into BufferGeometry on the main thread.
 *
 * Falls back to a synchronous in-thread bake (the SAME `bakeDisplacedVoxel`
 * function the worker runs) when `Worker` is unavailable — headless tests, SSR,
 * or any environment without module workers — so the geometry never differs and
 * the render path always has a result.
 */

import { bakeDisplacedVoxel, type BakedVoxel } from "./voxel_bake.ts";
import type { BakeRequest, BakeResponse, VoxelBakeSpec } from "./bake_protocol.ts";

interface Pending {
  resolve: (voxels: BakedVoxel[]) => void;
  count: number;
}

/**
 * Round-robins bake requests across a small pool of module workers and resolves
 * each with the baked per-voxel arrays.  One instance is created lazily by the
 * renderer; `bakeModel` is the only entry point.
 */
export class BakePool {
  #workers: Worker[] = [];
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #next = 0;

  constructor(size = 2) {
    // Only spawn workers in the browser.  The worker is bundled separately to
    // dist/bake_worker.js (scripts/build_client.ts) and that file only exists in
    // the browser dist — under Deno (tests, SSR) there is no such module, so use
    // the synchronous fallback.  `document` is the browser-only marker (probed
    // via globalThis so this compiles without the DOM lib in isolated checks).
    if (typeof Worker === "undefined" || !("document" in globalThis)) return;
    for (let i = 0; i < size; i++) {
      let worker: Worker;
      try {
        // Resolve relative to the bundled game.js via import.meta.url so the
        // worker loads from the same dist/ dir.
        worker = new Worker(new URL("./bake_worker.js", import.meta.url), { type: "module" });
      } catch {
        // Worker construction can throw if the environment forbids it — drop to
        // the synchronous fallback rather than crash the renderer.
        for (const w of this.#workers) w.terminate();
        this.#workers.length = 0;
        return;
      }
      worker.onmessage = (e: MessageEvent<BakeResponse>) => this.#onMessage(e.data);
      this.#workers.push(worker);
    }
  }

  /** True when a real worker pool is driving bakes (false → synchronous fallback). */
  get usingWorkers(): boolean {
    return this.#workers.length > 0;
  }

  #onMessage(res: BakeResponse): void {
    const pending = this.#pending.get(res.id);
    if (!pending) return;
    this.#pending.delete(res.id);
    const out: BakedVoxel[] = [];
    for (let i = 0; i < res.positions.length; i++) {
      out.push({ positions: res.positions[i], normals: res.normals[i] });
    }
    pending.resolve(out);
  }

  /**
   * Bake every voxel of a model (its Three.js-space centers + entity scale) and
   * resolve with the per-voxel arrays in request order.  Off-thread when a
   * worker pool exists, synchronous otherwise — the result is identical.
   */
  bakeModel(voxels: VoxelBakeSpec[]): Promise<BakedVoxel[]> {
    if (this.#workers.length === 0 || voxels.length === 0) {
      // Synchronous fallback — same pure function the worker runs.
      return Promise.resolve(voxels.map((v) => bakeDisplacedVoxel(v.px, v.py, v.pz, v.scale)));
    }
    const id = this.#nextId++;
    const worker = this.#workers[this.#next];
    this.#next = (this.#next + 1) % this.#workers.length;
    const req: BakeRequest = { id, voxels };
    return new Promise<BakedVoxel[]>((resolve) => {
      this.#pending.set(id, { resolve, count: voxels.length });
      worker.postMessage(req);
    });
  }

  dispose(): void {
    for (const w of this.#workers) w.terminate();
    this.#workers.length = 0;
    this.#pending.clear();
  }
}
