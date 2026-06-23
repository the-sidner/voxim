/**
 * BuildOccupancy is the one new mirror of placed-voxel state behind the cursor's
 * vertical stacking. Its column counting + O(1) removal are what make "place a
 * voxel → next ghost stacks one higher" correct, so they're pinned here.
 */
import { assertEquals } from "jsr:@std/assert";
import { BuildOccupancy } from "./build_occupancy.ts";

Deno.test("empty column has stack height 0", () => {
  const occ = new BuildOccupancy();
  assertEquals(occ.stackHeight(3, 4), 0);
});

Deno.test("add stacks the column by floored world position", () => {
  const occ = new BuildOccupancy();
  occ.add("a", 3.5, 4.5);   // → column (3,4)
  occ.add("b", 3.9, 4.1);   // same column
  assertEquals(occ.stackHeight(3, 4), 2);
  assertEquals(occ.stackHeight(4, 4), 0); // neighbour untouched
});

Deno.test("add is idempotent per entity id", () => {
  const occ = new BuildOccupancy();
  occ.add("a", 0.5, 0.5);
  occ.add("a", 0.5, 0.5);
  assertEquals(occ.stackHeight(0, 0), 1);
});

Deno.test("remove decrements the right column without a position", () => {
  const occ = new BuildOccupancy();
  occ.add("a", 2.5, 2.5);
  occ.add("b", 2.5, 2.5);
  occ.remove("a");
  assertEquals(occ.stackHeight(2, 2), 1);
  occ.remove("b");
  assertEquals(occ.stackHeight(2, 2), 0);
});

Deno.test("remove of an unknown id is a no-op", () => {
  const occ = new BuildOccupancy();
  occ.add("a", 1.5, 1.5);
  occ.remove("ghost");
  assertEquals(occ.stackHeight(1, 1), 1);
});

Deno.test("negative coordinates floor correctly", () => {
  const occ = new BuildOccupancy();
  occ.add("a", -0.5, -0.5);  // floor → (-1,-1)
  assertEquals(occ.stackHeight(-1, -1), 1);
  assertEquals(occ.stackHeight(0, 0), 0);
});

Deno.test("clear drops all columns", () => {
  const occ = new BuildOccupancy();
  occ.add("a", 0.5, 0.5);
  occ.add("b", 5.5, 5.5);
  occ.clear();
  assertEquals(occ.stackHeight(0, 0), 0);
  assertEquals(occ.stackHeight(5, 5), 0);
});
