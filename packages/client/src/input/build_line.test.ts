/**
 * The build-line helper is the WYSIWYG contract: the ghost preview and the
 * commit both consume `brushCells`, so its inclusivity + spacing decimation are
 * the thing that must be exactly right. Pure functions → deterministic tests.
 */
import { assertEquals } from "jsr:@std/assert";
import { bresenhamCells, brushCells, type Cell } from "./build_line.ts";
import type { BuildBrush, VoxelHit } from "./context.ts";

const hit = (cellX: number, cellY: number): VoxelHit => ({ cellX, cellY, baseZ: 0, layer: 0 });
const brush = (tool: "single" | "line", spacing = 0): BuildBrush => ({ tool, voxelSize: 1, spacing });

Deno.test("bresenhamCells is inclusive of both endpoints", () => {
  const line = bresenhamCells({ cellX: 0, cellY: 0 }, { cellX: 3, cellY: 0 });
  assertEquals(line, [
    { cellX: 0, cellY: 0 }, { cellX: 1, cellY: 0 },
    { cellX: 2, cellY: 0 }, { cellX: 3, cellY: 0 },
  ]);
});

Deno.test("bresenhamCells single cell = that cell", () => {
  assertEquals(bresenhamCells({ cellX: 5, cellY: 7 }, { cellX: 5, cellY: 7 }), [{ cellX: 5, cellY: 7 }]);
});

Deno.test("bresenhamCells diagonal steps both axes", () => {
  const line = bresenhamCells({ cellX: 0, cellY: 0 }, { cellX: 2, cellY: 2 });
  assertEquals(line, [{ cellX: 0, cellY: 0 }, { cellX: 1, cellY: 1 }, { cellX: 2, cellY: 2 }]);
});

Deno.test("brushCells single tool → just the cursor cell", () => {
  assertEquals(brushCells(brush("single"), hit(0, 0), hit(9, 9)), [{ cellX: 9, cellY: 9 }]);
});

Deno.test("brushCells line with no anchor → just the cursor cell", () => {
  assertEquals(brushCells(brush("line"), null, hit(4, 4)), [{ cellX: 4, cellY: 4 }]);
});

Deno.test("brushCells line spacing 0 = solid (every cell)", () => {
  const cells = brushCells(brush("line", 0), hit(0, 0), hit(4, 0));
  assertEquals(cells.length, 5);
  assertEquals(cells.map((c: Cell) => c.cellX), [0, 1, 2, 3, 4]);
});

Deno.test("brushCells line spacing 1 = every other cell, anchor kept", () => {
  const cells = brushCells(brush("line", 1), hit(0, 0), hit(6, 0));
  // run = 0..6 (7 cells); keep index 0,2,4,6
  assertEquals(cells.map((c: Cell) => c.cellX), [0, 2, 4, 6]);
});

Deno.test("brushCells line spacing 2 = every third cell, anchor kept", () => {
  const cells = brushCells(brush("line", 2), hit(0, 0), hit(9, 0));
  // run = 0..9 (10 cells); keep index 0,3,6,9
  assertEquals(cells.map((c: Cell) => c.cellX), [0, 3, 6, 9]);
});
