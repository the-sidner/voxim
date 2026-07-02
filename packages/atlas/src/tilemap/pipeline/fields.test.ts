/**
 * T-311 P3 field derivation — structural properties (not tuned values; the
 * Atlas-inspector overlays tune the formulas). Pure, headless.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { BoundaryKind } from "@voxim/protocol";
import { deriveFieldPlanes, type FieldDeriveInput } from "./fields.ts";
import { RIVER_DEPTH } from "./terrain.ts";

const G = 8;
const N = G * G;
const idx = (x: number, y: number) => x + y * G;

function baseInput(): FieldDeriveInput {
  const kindOf = new Uint16Array(N).fill(BoundaryKind.open);
  const heightMap = new Float32Array(N).fill(2.0);
  const chamberOf = new Uint16Array(N);
  const pathLevel = new Uint8Array(N);
  // forest cluster in the top-left corner
  kindOf[idx(0, 0)] = BoundaryKind.forest;
  kindOf[idx(1, 0)] = BoundaryKind.forest;
  kindOf[idx(0, 1)] = BoundaryKind.forest;
  // one water cell
  kindOf[idx(4, 4)] = BoundaryKind.water;
  // a chamber
  chamberOf[idx(5, 5)] = 7;
  // a path
  pathLevel[idx(2, 6)] = 200;
  return {
    gridSize: G, kindOf, heightMap, chamberOf, pathLevel, moisture: 0.5, tileSeed: 12345,
    params: {
      forestShadowPasses: 3, forestShadowDecay: 0.72,
      waterSpreadPasses: 4, waterSpreadDecay: 0.78,
      corruptionDrynessBias: 40, variantCorruptThreshold: 160,
      fertilityDappleAmp: 0, fertilityDappleScale: 0.05,
      wearFromTraffic: 0.85, corruptionRuinAgeWeight: 0.6,
      fertilityCanopyBase: 0.4, fertilityCanopyGain: 0.6,
      fertilityCorruptionDamp: 0.5,
    },
  };
}

Deno.test("T-311: water cell gets finite surfaceLevel (height+RIVER_DEPTH); dry cells NaN", () => {
  const f = deriveFieldPlanes(baseInput());
  assertEquals(f.surfaceLevel[idx(4, 4)], 2.0 + RIVER_DEPTH);
  assert(Number.isNaN(f.surfaceLevel[idx(0, 0)]), "dry cell is NaN");
  assert(Number.isNaN(f.surfaceLevel[idx(7, 7)]), "dry cell is NaN");
});

Deno.test("T-311: canopyLight is open (255) far from forest, lower under canopy", () => {
  const f = deriveFieldPlanes(baseInput());
  assertEquals(f.canopyLight[idx(7, 7)], 255, "far corner = open sky");
  assert(f.canopyLight[idx(0, 0)] < 255, "forest cell is shadowed");
  assert(f.canopyLight[idx(1, 1)] < 255, "near forest still shadowed (spread)");
});

Deno.test("T-311: ruinAge is per-chamber deterministic, 0 outside chambers", () => {
  const f = deriveFieldPlanes(baseInput());
  assert(f.ruinAge[idx(5, 5)] > 0, "chamber cell has age");
  assertEquals(f.ruinAge[idx(7, 7)], 0, "non-chamber cell has no age");
  // same chamber id + seed → same age (determinism)
  const f2 = deriveFieldPlanes(baseInput());
  assertEquals(f.ruinAge[idx(5, 5)], f2.ruinAge[idx(5, 5)]);
});

Deno.test("T-311: traffic mirrors pathLevel; wear follows it; overgrowth recedes on traffic", () => {
  const f = deriveFieldPlanes(baseInput());
  assertEquals(f.traffic[idx(2, 6)], 200);
  assertEquals(f.wear[idx(2, 6)], Math.trunc(200 * 0.85));
  // a trodden chamber cell would have less overgrowth than an untrodden one:
  const trodden = baseInput();
  trodden.pathLevel[idx(5, 5)] = 255;
  const g = deriveFieldPlanes(trodden);
  assert(g.overgrowth[idx(5, 5)] <= f.overgrowth[idx(5, 5)], "traffic suppresses overgrowth");
});

Deno.test("T-311 P4: fertility dapple varies fertility spatially; amp 0 is flat", () => {
  // amp 0 → open-sky cells away from forest/chambers share one fertility value.
  const flat = deriveFieldPlanes(baseInput());
  assertEquals(flat.fertility[idx(6, 6)], flat.fertility[idx(7, 7)]);
  // amp on → the same cells differ somewhere (patchy), stay in range, deterministic.
  const dappled = baseInput();
  dappled.params.fertilityDappleAmp = 0.45;
  dappled.params.fertilityDappleScale = 0.5; // coarse grid → high freq for the 8×8 test
  const d1 = deriveFieldPlanes(dappled);
  const d2 = deriveFieldPlanes(dappled);
  assertEquals(d1.fertility, d2.fertility, "dapple is seed-deterministic");
  const open = [idx(6, 6), idx(7, 7), idx(6, 7), idx(7, 6), idx(5, 7), idx(7, 5)];
  const values = new Set(open.map((i) => d1.fertility[i]));
  assert(values.size > 1, "dapple makes open-sky fertility vary");
});

Deno.test("T-311: full deriveFieldPlanes is deterministic", () => {
  const a = deriveFieldPlanes(baseInput());
  const b = deriveFieldPlanes(baseInput());
  assertEquals(a.canopyLight, b.canopyLight);
  assertEquals(a.corruption, b.corruption);
  assertEquals(a.fertility, b.fertility);
});
