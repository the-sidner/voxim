/**
 * CliffVoxeliser registry + boot cross-check (T-311 P6). Runs headless (no
 * THREE/DOM, THREE-free per the module's own contract). Pins: built-in
 * registration is idempotent and covers columnar/broken/sloped/stone_stair,
 * the cross-check resolves the real authored CliffProfileDefs, it fails fast
 * on an unregistered profile id, and buildCliffProfileIndex sorts alphabetically.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { JsonSource } from "@voxim/content";
import {
  registerBuiltinCliffVoxelisers,
  getCliffVoxeliser,
  cliffVoxeliserIds,
  crossCheckCliffVoxelisers,
  buildCliffProfileIndex,
} from "./cliff_voxeliser.ts";

const content = await JsonSource.load("packages/content/data");

Deno.test("T-311 P6: built-in cliff voxelisers register (idempotent) and cover the v1 vocabulary", () => {
  registerBuiltinCliffVoxelisers();
  registerBuiltinCliffVoxelisers(); // no-op, not a double-register throw
  for (const id of ["columnar", "broken", "sloped", "stone_stair"]) {
    assert(cliffVoxeliserIds().includes(id), `voxeliser "${id}" registered`);
  }
});

Deno.test("T-311 P6: columnar builds a contiguous stack from a synthetic context", () => {
  const v = getCliffVoxeliser("columnar")!;
  const atoms = v.build({
    x0: 5, y0: 5, h: 4.5, depth: 2.5,
    expE: true, expW: false, expS: false, expN: false,
    erosion: { tierCount: 4, jitterAmp: 0, edgeChinkiness: 0.3 },
    materialId: 3, dispMagBase: 0.05, og01: 0,
  });
  assertEquals(atoms.length, 4);
  const top = atoms[0];
  assert(Math.abs((top.cz + top.sz / 2) - 4.5) < 1e-9, "top course reaches the lip");
});

Deno.test("T-311 P6: stone_stair is a near-no-op single slab, not a stack", () => {
  const v = getCliffVoxeliser("stone_stair")!;
  const atoms = v.build({
    x0: 0, y0: 0, h: 2.0, depth: 1.0,
    expE: true, expW: false, expS: false, expN: false,
    erosion: { tierCount: 1, jitterAmp: 0, edgeChinkiness: 0 },
    materialId: 3, dispMagBase: 0.05, og01: 0,
  });
  assertEquals(atoms.length, 1);
});

Deno.test("T-311 P6: buildCliffProfileIndex sorts alphabetically (matches the atlas cliffStage order)", () => {
  const idx = buildCliffProfileIndex(content);
  const sorted = [...idx].sort((a, b) => a.localeCompare(b));
  assertEquals(idx, sorted, "index must already be in alphabetical order");
  assert(idx.includes("columnar") && idx.includes("stone_stair"));
});

Deno.test("T-311 P6: crossCheckCliffVoxelisers passes on the real content", () => {
  crossCheckCliffVoxelisers(content); // throws on a gap — reaching here is the pass
});

Deno.test("T-311 P6: cross-check throws when a CliffProfileDef has no registered voxeliser", () => {
  const bad = {
    cliffProfiles: { values: () => [{ id: "no_such_voxeliser" }] },
  } as unknown as Parameters<typeof crossCheckCliffVoxelisers>[0];
  let threw = false;
  try { crossCheckCliffVoxelisers(bad); } catch { threw = true; }
  assert(threw, "unregistered profile id rejected");
});
