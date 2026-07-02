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

Deno.test("terrace: normal one-sided cliff edge still terraces bottom-wide", () => {
  const { hm, mats } = flatChunk(2);
  // West half raised: a single long cliff along x=16 (one exposed side per cell).
  for (let y = 0; y < CHUNK; y++) for (let x = 0; x < 16; x++) hm.data[x + y * CHUNK] = 4.5;
  const byMat = buildChunkAtoms(hm, mats, {});
  const edge = [...byMat.values()].flat().filter((a) => a.cx > 15 && a.cx < 16 && a.cy > 15.9 && a.cy < 17.1 && a.cz > 2.6);
  assert(edge.length >= 2, "cliff cell terraces into a stack");
  // Bottom-wide ziggurat: lower boxes at least as wide as higher ones.
  const sorted = edge.slice().sort((a, b) => a.cz - b.cz);
  for (let i = 1; i < sorted.length; i++) {
    assert(sorted[i].sx <= sorted[i - 1].sx + 1e-9, "higher step must not outgrow the lower");
  }
});

Deno.test("warp: exposed faces jitter, welded faces + tops stay exact, deterministic", () => {
  const { hm, mats } = flatChunk(2);
  // West half raised → cliff cells at x=15, EAST face exposed, WEST face welded.
  for (let y = 0; y < CHUNK; y++) for (let x = 0; x < 16; x++) hm.data[x + y * CHUNK] = 4.5;
  const relief = (matId: number) => (matId === 3 ? 0.24 : undefined);
  const plain = [...buildChunkAtoms(hm, mats, {}).values()].flat();
  const warpedA = [...buildChunkAtoms(hm, mats, {}, undefined, relief).values()].flat();
  const warpedB = [...buildChunkAtoms(hm, mats, {}, undefined, relief).values()].flat();
  assertEquals(warpedA, warpedB, "warp is deterministic");
  assertEquals(plain.length, warpedA.length, "warp never adds/removes boxes");

  let anyJitter = false;
  for (let i = 0; i < plain.length; i++) {
    const p = plain[i], w = warpedA[i];
    // z is untouched everywhere (step heights + walkable tops stay collision-exact).
    assertEquals(w.cz, p.cz);
    assertEquals(w.sz, p.sz);
    const isSubLip = p.sz > 0.3 && (p.cz + p.sz / 2) < 4.5 - 1e-6;  // terrace steps below the lip
    if (!isSubLip) {
      assertEquals(w, p, "flat slabs + top steps stay exact");
      continue;
    }
    // Welded WEST face pinned exactly (no slit into the under-slab void).
    assertEquals(w.cx - w.sx / 2, p.cx - p.sx / 2, "welded face must not move");
    // Exposed EAST face jitters, bounded by the amplitude.
    const dEast = (w.cx + w.sx / 2) - (p.cx + p.sx / 2);
    assert(Math.abs(dEast) <= 0.12 + 1e-9, `east-face jitter bounded, got ${dEast}`);
    if (dEast !== 0) anyJitter = true;
  }
  assert(anyJitter, "warp actually jitters exposed faces");
});
