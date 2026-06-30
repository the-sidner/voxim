/**
 * T-311 P3 field-grid codec round-trips. The wire format is permanent
 * (wireIds 54/55/56) — pin that encode→decode is byte-identical for random,
 * all-zero, all-NaN, and worst-case (alternating) inputs, the RLE raw-escape
 * bounds the worst case, and coherent fields pack tiny.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import {
  vegFieldGridCodec, surfaceStateGridCodec, waterGridCodec,
  type VegFieldGridData, type SurfaceStateGridData, type WaterGridData,
} from "./components.ts";

const N = 1024;
function fill(fn: (i: number) => number): Uint8Array {
  const a = new Uint8Array(N);
  for (let i = 0; i < N; i++) a[i] = fn(i) & 0xff;
  return a;
}
const varied = (salt: number) => fill((i) => (i * 37 + salt * 101) >> 2);   // some runs
const uniform = (v: number) => fill(() => v);
const alternating = fill((i) => (i & 1) ? 0 : 255);                          // worst case

Deno.test("T-311: VegFieldGrid round-trips (varied / uniform / alternating)", () => {
  for (const planes of [
    { canopyLight: varied(1), corruption: varied(2), fertility: varied(3) },
    { canopyLight: uniform(0), corruption: uniform(255), fertility: uniform(128) },
    { canopyLight: alternating, corruption: uniform(0), fertility: varied(9) },
  ] as VegFieldGridData[]) {
    const out = vegFieldGridCodec.decode(vegFieldGridCodec.encode(planes));
    assertEquals(out.canopyLight, planes.canopyLight);
    assertEquals(out.corruption, planes.corruption);
    assertEquals(out.fertility, planes.fertility);
  }
});

Deno.test("T-311: all-zero VegFieldGrid packs tiny (RLE wins)", () => {
  const z: VegFieldGridData = { canopyLight: uniform(0), corruption: uniform(0), fertility: uniform(0) };
  const bytes = vegFieldGridCodec.encode(z);
  assert(bytes.length < 64, `coherent field packs small (${bytes.length} bytes)`);
});

Deno.test("T-311: alternating plane uses the raw escape (bounded, not 2×)", () => {
  // 3 alternating planes ≈ 3×1024 raw + framing, never the 2× RLE blow-up.
  const bytes = vegFieldGridCodec.encode({ canopyLight: alternating, corruption: alternating, fertility: alternating });
  assert(bytes.length <= 3 * N + 32, `raw-escape bounds the worst case (${bytes.length} bytes)`);
});

Deno.test("T-311: SurfaceStateGrid round-trips all 6 planes", () => {
  const s: SurfaceStateGridData = {
    wetness: varied(1), overgrowth: varied(2), wear: varied(3),
    variantIndex: varied(4), ruinAge: varied(5), traffic: varied(6),
  };
  const out = surfaceStateGridCodec.decode(surfaceStateGridCodec.encode(s));
  assertEquals(out, s);
});

Deno.test("T-311: WaterGrid round-trips water/dry runs with NaN sentinel", () => {
  const lvl = new Float32Array(N).fill(NaN);
  // a few water islands with finite levels
  for (let i = 100; i < 140; i++) lvl[i] = 3.25;
  for (let i = 500; i < 503; i++) lvl[i] = 1.5;
  const out = waterGridCodec.decode(waterGridCodec.encode({ surfaceLevel: lvl } as WaterGridData)).surfaceLevel;
  for (let i = 0; i < N; i++) {
    if (Number.isNaN(lvl[i])) assert(Number.isNaN(out[i]), `cell ${i} stays NaN`);
    else assertEquals(out[i], lvl[i], `cell ${i} level preserved`);
  }
});

Deno.test("T-311: all-dry WaterGrid packs tiny", () => {
  const bytes = waterGridCodec.encode({ surfaceLevel: new Float32Array(N).fill(NaN) });
  assert(bytes.length < 16, `all-dry packs to a single skip run (${bytes.length} bytes)`);
});
