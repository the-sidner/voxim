/**
 * T-213 tests for applyStairUnlock.
 *
 * Hand-built tiny tile layouts let us verify the lerp / flip / flood-
 * fill behaviour without hauling in the full pipeline. The fixture is
 * an 8×8 grid where:
 *
 *   . . . . . . . .
 *   . p p p p p p .    p = path (open, floor 0)
 *   . p p p W W .       W = wilderness blob (closed, wall 2.0)
 *   . p p p W W .
 *   . p p p W W W
 *   . p p p W W W
 *   . . . . . . . .
 *
 * The path zone id = 1; the wilderness blob = 2; off-tile = 0xFFFF.
 * Anchor at (3, 2) (last path pixel before the wilderness).
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { applyStairUnlock, markStairAnchor } from "./stair_unlock.ts";

const TS = 8;
const WALL = 2.0;
const FLOOR = 0.0;
const PATH_ZID = 1;
const WILD_ZID = 2;

function makeFixture() {
  const height = new Float32Array(TS * TS);
  const open   = new Uint8Array(TS * TS);
  const zone   = new Uint16Array(TS * TS).fill(0xFFFF);

  // Carve path: cols 1..6, rows 1..5, except the wilderness slab on right.
  // Wilderness: cols 4..6, rows 2..5.
  for (let y = 0; y < TS; y++) {
    for (let x = 0; x < TS; x++) {
      const i = y * TS + x;
      const isPath =
        y >= 1 && y <= 5 && x >= 1 && x <= 3 && !(y >= 2 && y <= 5 && x === 4);
      const isWilderness =
        y >= 2 && y <= 5 && x >= 4 && x <= 6;
      if (isPath) {
        open[i]   = 1;
        zone[i]   = PATH_ZID;
        height[i] = FLOOR;
      } else if (isWilderness) {
        open[i]   = 0;
        zone[i]   = WILD_ZID;
        height[i] = WALL;
      } else {
        open[i]   = 0;
        zone[i]   = 0xFFFF;
        height[i] = WALL;
      }
    }
  }
  return { height, open, zone };
}

Deno.test("applyStairUnlock: opens the wilderness blob walkability", () => {
  const { height, open, zone } = makeFixture();
  // Pre-condition: every wilderness pixel is openMask = 0.
  let wildBlocked = 0;
  for (let i = 0; i < zone.length; i++) {
    if (zone[i] === WILD_ZID) wildBlocked++;
  }
  assert(wildBlocked > 0, "fixture should have wilderness pixels");

  const touched = applyStairUnlock(height, open, zone, TS, {
    wildernessZoneId: WILD_ZID,
    anchor: { x: 3, y: 2 },
    wallHeight: WALL,
    rampDepth: 2,
    rampHalfWidth: 1,
  });
  assert(touched > 0, "expected at least one mutated pixel");

  // Post-condition: every wilderness pixel is now openMask = 1.
  for (let i = 0; i < zone.length; i++) {
    if (zone[i] === WILD_ZID) {
      assertEquals(open[i], 1, `wilderness pixel ${i} still blocked after unlock`);
    }
  }
});

Deno.test("applyStairUnlock: lerps ramp from floor to plateau height", () => {
  const { height, open, zone } = makeFixture();
  applyStairUnlock(height, open, zone, TS, {
    wildernessZoneId: WILD_ZID,
    anchor: { x: 3, y: 2 },
    wallHeight: WALL,
    rampDepth: 2,
    rampHalfWidth: 0,
  });
  // The anchor pixel stays at floor height (t=0 in the lerp).
  assertEquals(height[2 * TS + 3], FLOOR);
  // First ramp step into the wilderness (one pixel east of anchor):
  // t = 0.5 → height = 0 + 2.0 * 0.5 = 1.0.
  assertEquals(height[2 * TS + 4], 1.0);
  // The plateau reaches wallHeight at the end of the ramp.
  // x = 5, y = 2, t = 1.0 → height = WALL.
  assertEquals(height[2 * TS + 5], WALL);
});

Deno.test("applyStairUnlock: leaves an unrelated wilderness zone alone", () => {
  // Two separate wilderness zones, only one unlocked. The other must
  // stay openMask = 0.
  const TS2 = 10;
  const height = new Float32Array(TS2 * TS2);
  const open   = new Uint8Array(TS2 * TS2);
  const zone   = new Uint16Array(TS2 * TS2).fill(0xFFFF);
  // Path corridor across the middle row.
  for (let x = 0; x < TS2; x++) {
    const i = 5 * TS2 + x;
    open[i] = 1; zone[i] = PATH_ZID; height[i] = FLOOR;
  }
  // Wilderness zone WILD_ZID on top (rows 0..4, cols 2..4) — extends
  // up to row 4 so it's path-adjacent (path is row 5).
  for (let y = 0; y <= 4; y++) for (let x = 2; x <= 4; x++) {
    const i = y * TS2 + x;
    zone[i] = WILD_ZID; height[i] = WALL;
  }
  // Wilderness zone WILD_ZID+1 on bottom (rows 6..9, cols 5..7).
  for (let y = 6; y < 10; y++) for (let x = 5; x <= 7; x++) {
    const i = y * TS2 + x;
    zone[i] = WILD_ZID + 1; height[i] = WALL;
  }

  applyStairUnlock(height, open, zone, TS2, {
    wildernessZoneId: WILD_ZID,
    anchor: { x: 3, y: 5 },
    wallHeight: WALL,
  });

  // Top wilderness — opened.
  for (let y = 0; y <= 4; y++) for (let x = 2; x <= 4; x++) {
    assertEquals(open[y * TS2 + x], 1, `top wilderness (${x},${y}) should be open`);
  }
  // Bottom wilderness — still blocked.
  for (let y = 6; y < 10; y++) for (let x = 5; x <= 7; x++) {
    assertEquals(open[y * TS2 + x], 0, `bottom wilderness (${x},${y}) should still be blocked`);
  }
});

Deno.test("applyStairUnlock: no-ops when anchor is not adjacent to the target wilderness", () => {
  const { height, open, zone } = makeFixture();
  // Anchor far away — nowhere near the wilderness blob.
  const before = open.slice();
  applyStairUnlock(height, open, zone, TS, {
    wildernessZoneId: WILD_ZID,
    anchor: { x: 1, y: 1 },
    wallHeight: WALL,
  });
  // Helper returns 0 touched + buffers unchanged.
  for (let i = 0; i < open.length; i++) {
    assertEquals(open[i], before[i], `pixel ${i} changed despite no-op anchor`);
  }
});

Deno.test("applyStairUnlock: anchor out of bounds → no-op", () => {
  const { height, open, zone } = makeFixture();
  const before = open.slice();
  const touched = applyStairUnlock(height, open, zone, TS, {
    wildernessZoneId: WILD_ZID,
    anchor: { x: -1, y: 2 },
    wallHeight: WALL,
  });
  assertEquals(touched, 0);
  for (let i = 0; i < open.length; i++) assertEquals(open[i], before[i]);
});

// ---- markStairAnchor (T-213 visibility) -------------------------------

Deno.test("markStairAnchor: paints a patch of marker material at the anchor", () => {
  const { zone } = makeFixture();
  const materials = new Uint16Array(TS * TS).fill(7); // baseline = mud (7)
  const STONE = 3;
  const touched = markStairAnchor(materials, zone, TS, {
    wildernessZoneId: WILD_ZID,
    anchor: { x: 3, y: 2 },
    markerMaterialId: STONE,
    markerDepth: 3,
    markerHalfWidth: 1,
  });
  assert(touched > 0, "expected at least one pixel painted");
  // Anchor pixel itself + at least one pixel deeper into the wilderness
  // should be STONE now.
  assertEquals(materials[2 * TS + 3], STONE);
  assertEquals(materials[2 * TS + 4], STONE);
});

Deno.test("markStairAnchor: doesn't touch unrelated wilderness pixels", () => {
  const TS2 = 8;
  const materials = new Uint16Array(TS2 * TS2).fill(1); // baseline grass
  const zone = new Uint16Array(TS2 * TS2).fill(0xFFFF);
  // Path row 4, anchor at (3, 4).
  for (let x = 0; x < TS2; x++) zone[4 * TS2 + x] = PATH_ZID;
  // Wilderness A above the path (rows 0..3, cols 2..4).
  for (let y = 0; y < 4; y++) for (let x = 2; x <= 4; x++) zone[y * TS2 + x] = WILD_ZID;
  // Wilderness B below (rows 5..7, cols 5..7) — UNRELATED.
  for (let y = 5; y < 8; y++) for (let x = 5; x <= 7; x++) zone[y * TS2 + x] = WILD_ZID + 1;

  markStairAnchor(materials, zone, TS2, {
    wildernessZoneId: WILD_ZID,
    anchor: { x: 3, y: 4 },
    markerMaterialId: 3,
    markerDepth: 5,
    markerHalfWidth: 2,
  });

  // Wilderness B must NOT be painted.
  for (let y = 5; y < 8; y++) for (let x = 5; x <= 7; x++) {
    assertEquals(materials[y * TS2 + x], 1, `unrelated wilderness B (${x},${y}) shouldn't be painted`);
  }
});

Deno.test("markStairAnchor: works regardless of lock state — locked stair still gets painted", () => {
  // The marker function doesn't know about lock state — it just paints.
  // The CALLER decides whether to follow it up with applyStairUnlock.
  // This test asserts the function is purely about visuals.
  const { open, zone } = makeFixture();
  const materials = new Uint16Array(TS * TS).fill(7);
  const beforeOpen = open.slice();
  markStairAnchor(materials, zone, TS, {
    wildernessZoneId: WILD_ZID,
    anchor: { x: 3, y: 2 },
    markerMaterialId: 3,
  });
  // openMask is unchanged — marker doesn't unlock.
  for (let i = 0; i < open.length; i++) assertEquals(open[i], beforeOpen[i]);
  // Materials are changed at anchor.
  assertEquals(materials[2 * TS + 3], 3);
});
