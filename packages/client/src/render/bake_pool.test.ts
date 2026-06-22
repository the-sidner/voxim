/**
 * T-067 — the bake pool's synchronous fallback (used in any environment without
 * module Workers, e.g. these tests) must return the same arrays as a direct
 * `bakeDisplacedVoxel`, in request order.  This pins the fallback contract so
 * the render path always has a result even when no worker is available.
 */

import { assertEquals } from "jsr:@std/assert";
import { BakePool } from "./bake_pool.ts";
import { bakeDisplacedVoxel } from "./voxel_bake.ts";
import type { VoxelBakeSpec } from "./bake_protocol.ts";

Deno.test("BakePool falls back to synchronous bake when Worker is unavailable", async () => {
  // Under Deno there is no browser `document`, so the pool runs inline.
  const pool = new BakePool();
  assertEquals(pool.usingWorkers, false);

  const specs: VoxelBakeSpec[] = [
    { px: 0, py: 0, pz: 0, scale: { x: 0.2, y: 0.2, z: 0.2 } },
    { px: 0.5, py: 0.3, pz: -0.1, scale: { x: 0.2, y: 0.2, z: 0.2 } },
    { px: 1, py: 1, pz: 1, scale: { x: 0.3, y: 0.25, z: 0.21 } },
  ];

  const baked = await pool.bakeModel(specs);
  assertEquals(baked.length, specs.length);

  for (let i = 0; i < specs.length; i++) {
    const direct = bakeDisplacedVoxel(specs[i].px, specs[i].py, specs[i].pz, specs[i].scale);
    assertEquals(Array.from(baked[i].positions), Array.from(direct.positions));
    assertEquals(Array.from(baked[i].normals), Array.from(direct.normals));
  }

  pool.dispose();
});

Deno.test("BakePool.bakeModel resolves empty for an empty spec list", async () => {
  const pool = new BakePool();
  const baked = await pool.bakeModel([]);
  assertEquals(baked.length, 0);
  pool.dispose();
});
