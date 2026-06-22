/**
 * Enclosure detector (T-065) — the pure flood-fill in isolation.
 *
 * Hand-built wall grids drawn as ASCII, no World. Covers the headline cases
 * from the ticket: a full ring seals its interior, a one-cell gap leaks it
 * out, an open field encloses nothing, nested rings each seal independently,
 * plus the edges (single cell, all-wall, diagonal-only gap, off-boundary
 * interior wall).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import {
  cellKey,
  detectEnclosedCells,
  wallGridFromBuffer,
} from "./enclosure_detector.ts";

/**
 * Parse an ASCII map into a wall grid. `#` = wall, `.` = open. Every row must
 * be the same length. The first row is y=0; the first column is x=0.
 */
function grid(rows: string[]) {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  for (const r of rows) {
    assertEquals(r.length, width, `ragged row: "${r}"`);
  }
  const walls = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      walls[x + y * width] = rows[y][x] === "#" ? 1 : 0;
    }
  }
  return wallGridFromBuffer(walls, width, height);
}

/** Sorted "x,y" keys, for order-independent comparison. */
function sortedKeys(s: Set<string>): string[] {
  return [...s].sort();
}

Deno.test("full wall ring → interior cells enclosed", () => {
  const enclosed = detectEnclosedCells(grid([
    "#####",
    "#...#",
    "#...#",
    "#...#",
    "#####",
  ]));
  assertEquals(sortedKeys(enclosed), sortedKeys(new Set([
    cellKey(1, 1), cellKey(2, 1), cellKey(3, 1),
    cellKey(1, 2), cellKey(2, 2), cellKey(3, 2),
    cellKey(1, 3), cellKey(2, 3), cellKey(3, 3),
  ])));
});

Deno.test("ring with a 1-cell side gap → NOT enclosed (leaks to boundary)", () => {
  // East wall of the middle row punched open — interior drains out the gap.
  const enclosed = detectEnclosedCells(grid([
    "#####",
    "#...#",
    "#....",
    "#...#",
    "#####",
  ]));
  assertEquals(enclosed.size, 0);
});

Deno.test("ring with a gap on the boundary itself → still NOT enclosed", () => {
  // Top wall punched: the interior connects to the world through the missing
  // boundary cell.
  const enclosed = detectEnclosedCells(grid([
    "##.##",
    "#...#",
    "#...#",
    "#...#",
    "#####",
  ]));
  assertEquals(enclosed.size, 0);
});

Deno.test("open field → nothing enclosed", () => {
  const enclosed = detectEnclosedCells(grid([
    ".....",
    ".....",
    ".....",
    ".....",
  ]));
  assertEquals(enclosed.size, 0);
});

Deno.test("all walls → nothing enclosed (no open cells)", () => {
  const enclosed = detectEnclosedCells(grid([
    "###",
    "###",
    "###",
  ]));
  assertEquals(enclosed.size, 0);
});

Deno.test("diagonal-only gap does NOT leak (4-connected flood)", () => {
  // The interior open cell touches the outside open field only at a corner
  // (diagonal). 4-connectivity treats that corner as sealed → enclosed.
  //   row0: # # #
  //   row1: # . #   <- interior open at (1,1)
  //   row2: . # #   <- outside open at (0,2), diagonal to (1,1)
  const enclosed = detectEnclosedCells(grid([
    "###",
    "#.#",
    ".##",
  ]));
  assertEquals(sortedKeys(enclosed), [cellKey(1, 1)]);
});

Deno.test("nested rings → each shell's interior enclosed independently", () => {
  // Outer 7×7 ring with an inner 3×3 ring inside it; the gap between the two
  // rings (the moat) is enclosed by the outer ring, and the inner room is
  // enclosed by the inner ring. Both are sealed from the boundary.
  const enclosed = detectEnclosedCells(grid([
    "#######",
    "#.....#",
    "#.###.#",
    "#.#.#.#",
    "#.###.#",
    "#.....#",
    "#######",
  ]));
  // Inner room centre.
  assert(enclosed.has(cellKey(3, 3)), "inner room cell enclosed");
  // A moat cell between the two rings.
  assert(enclosed.has(cellKey(1, 1)), "moat cell enclosed");
  assert(enclosed.has(cellKey(5, 5)), "moat cell enclosed");
  // The inner ring's wall cells are never enclosed.
  assert(!enclosed.has(cellKey(2, 2)), "wall cell not enclosed");
  // Every enclosed cell is an open (non-wall) cell.
  for (const key of enclosed) {
    const [x, y] = key.split(",").map(Number);
    assert(
      [
        "#######",
        "#.....#",
        "#.###.#",
        "#.#.#.#",
        "#.###.#",
        "#.....#",
        "#######",
      ][y][x] === ".",
      `enclosed cell ${key} must be open`,
    );
  }
});

Deno.test("two separate sealed rooms in one grid", () => {
  // Two 1-cell rooms, each fully walled, sharing the field. Both enclosed.
  const enclosed = detectEnclosedCells(grid([
    "#######",
    "#.#.#.#",
    "#######",
  ]));
  assertEquals(sortedKeys(enclosed), sortedKeys(new Set([
    cellKey(1, 1), cellKey(3, 1), cellKey(5, 1),
  ])));
});

Deno.test("interior wall blob that doesn't seal → nothing enclosed", () => {
  // A lone wall blob in an open field encloses nothing — the field is one
  // connected open region reachable from the boundary.
  const enclosed = detectEnclosedCells(grid([
    ".....",
    "..#..",
    ".###.",
    "..#..",
    ".....",
  ]));
  assertEquals(enclosed.size, 0);
});

Deno.test("single open cell on a 1×1 grid → boundary, not enclosed", () => {
  const enclosed = detectEnclosedCells(grid(["."]));
  assertEquals(enclosed.size, 0);
});

Deno.test("zero-dimension grid → empty set", () => {
  const enclosed = detectEnclosedCells(wallGridFromBuffer(new Uint8Array(0), 0, 0));
  assertEquals(enclosed.size, 0);
});

Deno.test("custom WallGrid view (no buffer) works", () => {
  // Exercise the WallGrid interface directly: a procedural 6×6 ring.
  const enclosed = detectEnclosedCells({
    width: 6,
    height: 6,
    isWall: (x, y) => x === 0 || y === 0 || x === 5 || y === 5,
  });
  // 4×4 interior, all enclosed.
  assertEquals(enclosed.size, 16);
  assert(enclosed.has(cellKey(2, 3)));
});
