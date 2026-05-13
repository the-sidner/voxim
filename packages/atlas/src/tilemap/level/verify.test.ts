/**
 * verifyLevelInvariants tests (T-214 step 9).
 *
 * Confirms the bake-time assertions catch the three violation cases:
 *   - plateau region with an unsealed pixel (openMask=1)
 *   - region referencing a zoneId that's absent from zoneOf
 *   - stair edge referencing a region that doesn't exist
 * Plus a positive case: a well-formed level passes silently.
 */

import { assert, assertThrows } from "jsr:@std/assert";
import { verifyLevelInvariants } from "./verify.ts";
import { emptyLevel, type LevelDef } from "./types.ts";

const GRID = 4;

function basePathPlateauLevel(): LevelDef {
  // 4×4 tile: left half = path zone (id 1), right half = plateau (id 2).
  const level = emptyLevel({ gridSize: GRID, tileSize: GRID, seed: 0, cellX: 0, cellY: 0 });
  level.regions = [
    {
      kind: "path",
      id: "path:z1", zoneId: 1, area: 8,
      centroid: { x: 1, y: 1.5 }, bbox: { minX: 0, minY: 0, maxX: 1, maxY: 3 },
      name: "", topologyRole: "chamber", isEntry: false,
    },
    {
      kind: "plateau",
      id: "plateau:z2", zoneId: 2, area: 8,
      centroid: { x: 3, y: 1.5 }, bbox: { minX: 2, minY: 0, maxX: 3, maxY: 3 },
      name: "", topologyRole: "thicket",
      wallKind: "stone", wallStep: 2, jumpable: false,
    },
  ];
  return level;
}

function baseZoneOf(): Uint16Array {
  const z = new Uint16Array(GRID * GRID);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) z[y * GRID + x] = x < 2 ? 1 : 2;
  }
  return z;
}

function baseOpenMask(): Uint8Array {
  // path (zoneId 1) open, plateau (zoneId 2) sealed.
  const m = new Uint8Array(GRID * GRID);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) m[y * GRID + x] = x < 2 ? 1 : 0;
  }
  return m;
}

Deno.test("verify: well-formed level passes silently", () => {
  const level = basePathPlateauLevel();
  verifyLevelInvariants(level, baseOpenMask(), baseZoneOf(), GRID);
});

Deno.test("verify: unsealed plateau pixel throws", () => {
  const level = basePathPlateauLevel();
  const open = baseOpenMask();
  // Open up one plateau pixel — simulates a reducer bug that leaks the wall.
  open[0 * GRID + 2] = 1;
  assertThrows(
    () => verifyLevelInvariants(level, open, baseZoneOf(), GRID),
    Error,
    "plateau region with zoneId=2",
  );
});

Deno.test("verify: region with no pixels in zoneOf throws", () => {
  const level = basePathPlateauLevel();
  // Add a third region with a zoneId no pixel reports.
  level.regions.push({
    kind: "path",
    id: "path:z99", zoneId: 99, area: 0,
    centroid: { x: 0, y: 0 }, bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    name: "", topologyRole: "chamber", isEntry: false,
  });
  assertThrows(
    () => verifyLevelInvariants(level, baseOpenMask(), baseZoneOf(), GRID),
    Error,
    "zoneId=99",
  );
});

Deno.test("verify: stair edge to a missing region throws", () => {
  const level = basePathPlateauLevel();
  level.edges.stairs.push({
    id: "stair_bogus",
    from: "path:z1",
    to: "plateau:z404", // doesn't exist
    anchorPixel: { x: 1, y: 1 },
    climbDir: { dx: 1, dy: 0 },
    rampDepth: 4, rampHalfWidth: 2,
    locked: null,
  });
  assertThrows(
    () => verifyLevelInvariants(level, baseOpenMask(), baseZoneOf(), GRID),
    Error,
    "to=plateau:z404",
  );
});

Deno.test("verify: stair-unlocked path-side anchor doesn't trip the seal check", () => {
  // The path-side anchor of a stair is always openMask=1 (it lives on a
  // path zone). The invariant only fires on plateau zones — so a real
  // tile with stairs at the boundary should pass. This is a regression
  // canary against an over-eager check that scans the wrong pixels.
  const level = basePathPlateauLevel();
  level.edges.stairs.push({
    id: "stair_ok",
    from: "path:z1",
    to: "plateau:z2",
    anchorPixel: { x: 1, y: 1 }, // path pixel
    climbDir: { dx: 1, dy: 0 },
    rampDepth: 4, rampHalfWidth: 2,
    locked: null,
  });
  // No throw expected.
  verifyLevelInvariants(level, baseOpenMask(), baseZoneOf(), GRID);
  assert(true);
});
