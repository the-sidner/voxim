/**
 * roof_renderer's pure helpers (T-066) — connected-component grouping and
 * merged-quad geometry building. No THREE scene/material dependency;
 * headless, same idiom as water_renderer.test.ts.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { buildRoofGeometry, groupConnectedComponents } from "./roof_renderer.ts";

Deno.test("groupConnectedComponents: empty input yields no components", () => {
  assertEquals(groupConnectedComponents([]), []);
});

Deno.test("groupConnectedComponents: a single cell is its own component", () => {
  const groups = groupConnectedComponents([{ x: 3, y: 4 }]);
  assertEquals(groups.length, 1);
  assertEquals(groups[0], [{ x: 3, y: 4 }]);
});

Deno.test("groupConnectedComponents: a 3x3 block is one 4-connected component", () => {
  const cells = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) cells.push({ x, y });
  const groups = groupConnectedComponents(cells);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].length, 9);
});

Deno.test("groupConnectedComponents: two disjoint rooms yield two components", () => {
  const cells = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, // room A
    { x: 10, y: 10 }, { x: 11, y: 10 }, // room B, far away
  ];
  const groups = groupConnectedComponents(cells);
  assertEquals(groups.length, 2);
  const sizes = groups.map((g) => g.length).sort();
  assertEquals(sizes, [2, 2]);
});

Deno.test("groupConnectedComponents: diagonal-only adjacency does NOT merge (4-connected)", () => {
  const cells = [{ x: 0, y: 0 }, { x: 1, y: 1 }]; // touch only at a corner
  const groups = groupConnectedComponents(cells);
  assertEquals(groups.length, 2);
});

Deno.test("groupConnectedComponents: an L-shape is one component (connected through the corner cell)", () => {
  const cells = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  const groups = groupConnectedComponents(cells);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].length, 3);
});

// ---- buildRoofGeometry ----

Deno.test("buildRoofGeometry: a single cell produces one quad", () => {
  const geo = buildRoofGeometry([{ x: 5, y: 5 }], () => 12.5);
  const pos = geo.getAttribute("position");
  assertEquals(pos.count, 4);
  for (let i = 0; i < 4; i++) assertEquals(pos.getY(i), 12.5);
});

Deno.test("buildRoofGeometry: a contiguous same-height row run merges into ONE quad", () => {
  const cells = Array.from({ length: 10 }, (_, x) => ({ x, y: 3 }));
  const geo = buildRoofGeometry(cells, () => 8.0);
  assertEquals(geo.getAttribute("position").count, 4);
});

Deno.test("buildRoofGeometry: a row run with a gap splits into separate quads", () => {
  const cells = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 0 }, { x: 6, y: 0 }];
  const geo = buildRoofGeometry(cells, () => 3.0);
  // Two runs: [0,2) and [5,7) — 2 quads = 8 verts.
  assertEquals(geo.getAttribute("position").count, 8);
});

Deno.test("buildRoofGeometry: differing per-cell heights within a run split into separate quads", () => {
  const cells = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
  const heights = new Map([["0,0", 5.0], ["1,0", 5.0], ["2,0", 6.0]]);
  const geo = buildRoofGeometry(cells, (x, y) => heights.get(`${x},${y}`)!);
  // Run [0,2) at height 5.0, run [2,3) at height 6.0 — 2 quads = 8 verts.
  assertEquals(geo.getAttribute("position").count, 8);
});

Deno.test("buildRoofGeometry: world-space vertex positions match cell coordinates", () => {
  const geo = buildRoofGeometry([{ x: 7, y: 9 }], () => 2.0);
  const pos = geo.getAttribute("position");
  // Quad corners span the unit cell [7,8) x [9,10) at y=2.0.
  const xs = [pos.getX(0), pos.getX(1), pos.getX(2), pos.getX(3)].sort((a, b) => a - b);
  const zs = [pos.getZ(0), pos.getZ(1), pos.getZ(2), pos.getZ(3)].sort((a, b) => a - b);
  assertEquals(xs, [7, 7, 8, 8]);
  assertEquals(zs, [9, 9, 10, 10]);
});

Deno.test("buildRoofGeometry: a 3x3 block produces geometry with no gaps (9 unit cells, merged rows)", () => {
  const cells: { x: number; y: number }[] = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) cells.push({ x, y });
  const geo = buildRoofGeometry(cells, () => 4.0);
  // Each row [0,3) merges into one quad → 3 rows = 3 quads = 12 verts.
  assertEquals(geo.getAttribute("position").count, 12);
  const pos = geo.getAttribute("position");
  for (let i = 0; i < pos.count; i++) assert(pos.getY(i) === 4.0);
});
