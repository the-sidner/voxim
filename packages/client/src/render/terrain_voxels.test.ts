/**
 * Terrain voxelisation (T-310 terraces + T-311 warp). Pure, headless.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { buildChunkAtoms } from "./terrain_voxels.ts";
import type { HeightmapData, MaterialGridData } from "@voxim/codecs";

const CHUNK = 32;

function flatChunk(h: number): { hm: HeightmapData; mats: MaterialGridData } {
  return {
    hm: { chunkX: 0, chunkY: 0, data: new Float32Array(CHUNK * CHUNK).fill(h) },
    mats: { data: new Uint16Array(CHUNK * CHUNK).fill(3) },
  };
}

Deno.test("terrace: a 1-voxel-wide ridge still renders (both sides exposed)", () => {
  const { hm, mats } = flatChunk(2);
  // A tall 1-cell-wide north-south ridge: both E and W sides exposed.
  for (let y = 8; y < 24; y++) hm.data[16 + y * CHUNK] = 4.5;
  const byMat = buildChunkAtoms(hm, mats, {});
  const ridge = [...byMat.values()].flat().filter((a) =>
    a.cx > 16 && a.cx < 17 && a.cy > 15.9 && a.cy < 17.1 && a.cz > 2,
  );
  assert(ridge.length > 0, "ridge cell must emit terrace boxes (was: fully receded → break before any push)");
  // The stack's top face must sit at the collision height (walkable surface).
  const topZ = Math.max(...ridge.map((a) => a.cz + a.sz / 2));
  assert(Math.abs(topZ - 4.5) < 1e-6, `terrace top must reach h=4.5, got ${topZ}`);
  // Every box keeps a usable footprint.
  for (const a of ridge) {
    assert(a.sx >= 0.12 && a.sy >= 0.12, `degenerate box ${a.sx}×${a.sy}`);
  }
});

Deno.test("cliff cells stack full-footprint stones: contiguous courses, base to lip", () => {
  const { hm, mats } = flatChunk(2);
  // West half raised: a single long cliff along x=16 (one exposed side per cell).
  for (let y = 0; y < CHUNK; y++) for (let x = 0; x < 16; x++) hm.data[x + y * CHUNK] = 4.5;
  const byMat = buildChunkAtoms(hm, mats, {});
  const edge = [...byMat.values()].flat()
    .filter((a) => a.cx > 15 && a.cx < 16 && a.cy > 15.9 && a.cy < 17.1 && a.sz > 0.3)
    .sort((a, b) => (b.cz) - (a.cz));
  assert(edge.length >= 2 && edge.length <= 5, `stack of 2..5 stones, got ${edge.length}`);
  // Full footprint (no inset geometry — the look comes from warp, off here).
  for (const a of edge) { assertEquals(a.sx, 1); assertEquals(a.sy, 1); }
  // Contiguous courses spanning [bottom, lip]: top face at h, no z gaps.
  assert(Math.abs((edge[0].cz + edge[0].sz / 2) - 4.5) < 1e-9, "top stone reaches the lip");
  for (let i = 1; i < edge.length; i++) {
    const above = edge[i - 1].cz - edge[i - 1].sz / 2;
    const below = edge[i].cz + edge[i].sz / 2;
    assert(Math.abs(above - below) < 1e-9, "stone courses are contiguous");
  }
  assert(Math.abs((edge.at(-1)!.cz - edge.at(-1)!.sz / 2) - 2) < 1e-9, "bottom stone sits on the base");
});

Deno.test("warp: exposed faces + course seams jitter; lip, base and welds stay exact", () => {
  const { hm, mats } = flatChunk(2);
  // West half raised → cliff cells at x=15, EAST face exposed, WEST face welded.
  for (let y = 0; y < CHUNK; y++) for (let x = 0; x < 16; x++) hm.data[x + y * CHUNK] = 4.5;
  const relief = (matId: number) => (matId === 3 ? { warp: 0.3 } : undefined);
  const plain = [...buildChunkAtoms(hm, mats, {}).values()].flat();
  const warpedA = [...buildChunkAtoms(hm, mats, {}, undefined, relief).values()].flat();
  const warpedB = [...buildChunkAtoms(hm, mats, {}, undefined, relief).values()].flat();
  assertEquals(warpedA, warpedB, "warp is deterministic");
  assertEquals(plain.length, warpedA.length, "warp never adds/removes boxes");

  let faceJitter = false, seamJitter = false;
  for (let i = 0; i < plain.length; i++) {
    const p = plain[i], w = warpedA[i];
    const isStack = p.sz > 0.3 && p.sz < 2;                  // cliff-stack stones
    if (!isStack) { assertEquals(w, p, "flat slabs stay exact"); continue; }
    const isTop = Math.abs((p.cz + p.sz / 2) - 4.5) < 1e-9;  // the lip stone
    if (isTop) {
      // Footprint + top face exact (plateau lip = collision edge); only its
      // BOTTOM face rides the jittered course boundary below it.
      assertEquals(w.cx, p.cx); assertEquals(w.sx, p.sx);
      assertEquals(w.cy, p.cy); assertEquals(w.sy, p.sy);
      assert(Math.abs((w.cz + w.sz / 2) - 4.5) < 1e-9, "lip top face exact");
      assertEquals(w.dispMag, undefined, "lip keeps the terrain weld mag");
      continue;
    }
    // Welded WEST face only ever moves INTO the hill (oversize), never out.
    assert((w.cx - w.sx / 2) <= (p.cx - p.sx / 2) + 1e-9, "welded face never pulls outward");
    // Exposed EAST face jitters, bounded by the amplitude.
    const dEast = (w.cx + w.sx / 2) - (p.cx + p.sx / 2);
    assert(Math.abs(dEast) <= 0.15 + 1e-9, `east-face jitter bounded, got ${dEast}`);
    if (dEast !== 0) faceJitter = true;
    // Course seams move (uneven coursework) but stay bounded.
    if (Math.abs(w.cz - p.cz) > 1e-9) seamJitter = true;
    // The stack base never floats above the ground (it may sink below — the
    // oversize clips into the base, which is the point).
    if (Math.abs((p.cz - p.sz / 2) - 2) < 1e-9) {
      assert((w.cz - w.sz / 2) <= 2 + 1e-9, "bottom face never floats above the base");
    }
    assert(w.dispMag !== undefined && w.dispMag > 0.045, "stones displace chunkier than terrain");
  }
  assert(faceJitter, "warp jitters exposed faces");
  assert(seamJitter, "warp unevens the course seams");
});

Deno.test("warp keeps courses gap-free (stones overlap into each other, never apart)", () => {
  const { hm, mats } = flatChunk(2);
  for (let y = 0; y < CHUNK; y++) for (let x = 0; x < 16; x++) hm.data[x + y * CHUNK] = 4.5;
  const relief = () => ({ warp: 0.3 });
  const stack = [...buildChunkAtoms(hm, mats, {}, undefined, relief).values()].flat()
    .filter((a) => a.cx > 14.6 && a.cx < 16.4 && a.cy > 15.9 && a.cy < 17.1 && a.sz > 0.3 && a.sz < 2.5)
    .sort((a, b) => b.cz - a.cz);
  assert(stack.length >= 2);
  for (let i = 1; i < stack.length; i++) {
    const above = stack[i - 1].cz - stack[i - 1].sz / 2;
    const below = stack[i].cz + stack[i].sz / 2;
    assert(below >= above - 1e-9, "no z gap between courses (overlap is fine)");
  }
});

Deno.test("disturbance axis: disturbanceField scales roughness AND tint mottle per cell", () => {
  const { hm, mats } = flatChunk(2);
  const relief = () => ({
    surfaceWarp: 0.15,
    disturbanceField: [{ field: "traffic", curve: "linear" as const, min: 0.55, max: 0.05, weight: 1.0 }],
  });
  // traffic plane: left half trodden (→ civilized), right half wilderness (→ wild)
  const surface = {
    overgrowth: new Uint8Array(CHUNK * CHUNK),
    wetness: new Uint8Array(CHUNK * CHUNK),
    mossBiasFor: () => undefined,
    wets: () => false,
    sample: (field: string, cellIdx: number) =>
      field === "traffic" ? ((cellIdx % CHUNK) < 16 ? 1 : 0) : 0,
  };
  const plain = [...buildChunkAtoms(hm, mats, {}).values()].flat();
  const roughA = [...buildChunkAtoms(hm, mats, {}, surface, relief).values()].flat();
  const roughB = [...buildChunkAtoms(hm, mats, {}, surface, relief).values()].flat();
  assertEquals(roughA, roughB, "deterministic");
  assertEquals(plain.length, roughA.length);

  let roughCount = 0, smoothCount = 0;
  for (let i = 0; i < plain.length; i++) {
    const p = plain[i], w = roughA[i];
    const lx = Math.round(p.cx - 0.5);
    if (lx < 16) {
      // civilized: flat + welded geometry, mottle collapses to the 25% floor
      assertEquals(w.dispSeed, undefined, "civilized slab stays welded");
      assertEquals(w.sx, p.sx, "civilized slab keeps exact footprint");
      assertEquals(w.tintScale, 0.25, "civilized mottle at the floor");
      smoothCount++;
    } else {
      // wilderness: seeded, chunkier, oversized into solid, full mottle
      assertEquals(typeof w.dispSeed, "number", "wilderness slab is seeded");
      assert(w.dispMag! > 0.045, "wilderness slab displaces chunkier");
      assert(w.sx > p.sx && w.sz > p.sz, "wilderness slab oversizes into solid");
      assert(w.cz + w.sz / 2 <= p.cz + p.sz / 2 + 1e-9, "top face never rises above collision h");
      assertEquals(w.tintScale, 1, "wilderness keeps full mottle");
      roughCount++;
    }
  }
  assert(roughCount > 0 && smoothCount > 0);
});
