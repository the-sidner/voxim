/**
 * sun_arc — pure altitude/azimuth/direction function (T-311 P5a). Pure,
 * headless; pins dawn/noon/dusk/midnight angles and continuity across the
 * midnight wrap.
 */
import { assert, assertAlmostEquals } from "jsr:@std/assert";
import { sunArc, timeOfDay01, type SunArcParams } from "./sun_arc.ts";

// Matches data/atmospheres/default.json — noon direction reproduces the old
// fixed SUN_DIR = (20,100,-15).normalize() exactly (the wiring-commit
// acceptance test lives here as a pinned regression).
const DEFAULT_PARAMS: SunArcParams = {
  dawnAzimuthDeg: -95,
  duskAzimuthDeg: 21.26,
  maxAltitudeDeg: 75.96375653207352,
  nightDepthDeg: 20,
};

Deno.test("T-311 P5a: noon reproduces the retired fixed SUN_DIR direction", () => {
  const noon = sunArc(0.5, DEFAULT_PARAMS);
  assertAlmostEquals(noon.dir.x, 0.19402850002906638, 1e-6);
  assertAlmostEquals(noon.dir.y, 0.9701425001453319, 1e-6);
  assertAlmostEquals(noon.dir.z, -0.1455213750217998, 1e-6);
  assertAlmostEquals(noon.altitudeDeg, DEFAULT_PARAMS.maxAltitudeDeg, 1e-6);
});

Deno.test("T-311 P5a: midnight sun sits below the horizon", () => {
  const midnight = sunArc(0.0, DEFAULT_PARAMS);
  assert(midnight.altitudeDeg < 0, "midnight altitude should be below the horizon");
  assertAlmostEquals(midnight.altitudeDeg, -DEFAULT_PARAMS.nightDepthDeg, 1e-6);
  // Same instant wrapping either direction (t=0 vs t=1) must agree exactly.
  const wrapped = sunArc(1.0, DEFAULT_PARAMS);
  assertAlmostEquals(midnight.altitudeDeg, wrapped.altitudeDeg, 1e-9);
  assertAlmostEquals(midnight.azimuthDeg, wrapped.azimuthDeg, 1e-9);
});

Deno.test("T-311 P5a: dawn/dusk altitudes are equal and between night/noon", () => {
  const dawn = sunArc(0.25, DEFAULT_PARAMS);
  const dusk = sunArc(0.75, DEFAULT_PARAMS);
  assertAlmostEquals(dawn.altitudeDeg, dusk.altitudeDeg, 1e-6);
  assert(dawn.altitudeDeg > -DEFAULT_PARAMS.nightDepthDeg);
  assert(dawn.altitudeDeg < DEFAULT_PARAMS.maxAltitudeDeg);
  assertAlmostEquals(dawn.azimuthDeg, DEFAULT_PARAMS.dawnAzimuthDeg, 1e-6);
  assertAlmostEquals(dusk.azimuthDeg, DEFAULT_PARAMS.duskAzimuthDeg, 1e-6);
});

Deno.test("T-311 P5a: continuity across the midnight wrap (no discontinuity)", () => {
  const justBefore = sunArc(0.999, DEFAULT_PARAMS);
  const justAfter = sunArc(0.001, DEFAULT_PARAMS);
  // Both samples are ~0.002 of a day apart around the t=0/1 seam — altitude,
  // azimuth, and direction should all be close, not snapped.
  assert(Math.abs(justBefore.altitudeDeg - justAfter.altitudeDeg) < 0.5);
  assert(Math.abs(justBefore.dir.x - justAfter.dir.x) < 0.01);
  assert(Math.abs(justBefore.dir.y - justAfter.dir.y) < 0.01);
  assert(Math.abs(justBefore.dir.z - justAfter.dir.z) < 0.01);
});

Deno.test("T-311 P5a: returned direction is normalized", () => {
  for (const t of [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.999]) {
    const { dir } = sunArc(t, DEFAULT_PARAMS);
    const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    assertAlmostEquals(len, 1, 1e-6, `t=${t}`);
  }
});

Deno.test("T-311 P5a: timeOfDay01 matches WorldClock's wrap convention", () => {
  assertAlmostEquals(timeOfDay01(0, 14400), 0);
  assertAlmostEquals(timeOfDay01(3600, 14400), 0.25);
  assertAlmostEquals(timeOfDay01(7200, 14400), 0.5);
  assertAlmostEquals(timeOfDay01(10800, 14400), 0.75);
  assertAlmostEquals(timeOfDay01(14400, 14400), 0);
  assertAlmostEquals(timeOfDay01(14400 * 3 + 3600, 14400), 0.25);
});
