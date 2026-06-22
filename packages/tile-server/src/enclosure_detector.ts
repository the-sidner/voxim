/**
 * Enclosure detection (T-065, server core).
 *
 * A *pure* flood-fill over a rectangular wall grid. The grid is two kinds of
 * cell: WALL (impassable / closed) and OPEN (walkable). An OPEN cell is
 * "enclosed" when it is sealed off from the grid's outer boundary by walls —
 * i.e. you cannot reach it by stepping (4-connected) through OPEN cells from
 * any cell on the grid edge.
 *
 * Algorithm:
 *   1. Flood-fill OPEN cells starting from every OPEN cell on the boundary
 *      (4-connectivity). This marks every OPEN cell that "leaks" to the
 *      outside world.
 *   2. Every OPEN cell NOT reached by that flood is enclosed (sealed inside
 *      walls). Wall cells are never enclosed (they ARE the wall).
 *
 * Correctness corollaries this gives for free:
 *   - A full wall ring → its interior OPEN cells are enclosed.
 *   - A ring with a one-cell gap → the interior leaks out through the gap and
 *     is NOT enclosed (a diagonal gap does NOT leak: flood is 4-connected,
 *     matching how movement collision treats cells).
 *   - An open field with no walls → the whole grid floods from the boundary,
 *     nothing is enclosed.
 *   - Nested rings → each sealed shell's interior is independently enclosed.
 *
 * Kept free of World/ECS: it takes a grid + dimensions and returns a set of
 * cell keys, so it unit-tests with hand-built grids. The EnclosureSystem is
 * the only place that derives a WallGrid from live chunk OpenMask data.
 */

/**
 * Read-only view of a rectangular wall grid. `isWall(x, y)` is true for a
 * closed/impassable cell, false for an open/walkable one. Coordinates are
 * grid-local cell indices in `[0, width) × [0, height)`.
 */
export interface WallGrid {
  readonly width: number;
  readonly height: number;
  isWall(x: number, y: number): boolean;
}

/** Pack a cell coordinate into the `"x,y"` key the enclosed-set uses. */
export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * Compute the set of enclosed OPEN cells in `grid`, keyed as `"x,y"`.
 *
 * An empty grid (zero width or height) returns an empty set. A grid that is
 * entirely walls returns an empty set (no OPEN cells to enclose). The returned
 * set never contains a wall cell.
 */
export function detectEnclosedCells(grid: WallGrid): Set<string> {
  const { width, height } = grid;
  const enclosed = new Set<string>();
  if (width <= 0 || height <= 0) return enclosed;

  // `reached[idx]` — true once the boundary flood has visited OPEN cell idx.
  // Wall cells stay false but are excluded from the enclosed pass explicitly.
  const reached = new Uint8Array(width * height);
  const idx = (x: number, y: number) => x + y * width;

  // BFS queue of cell indices. Seed it with every OPEN boundary cell.
  const queue: number[] = [];
  const seed = (x: number, y: number) => {
    if (grid.isWall(x, y)) return;
    const i = idx(x, y);
    if (reached[i]) return;
    reached[i] = 1;
    queue.push(i);
  };
  for (let x = 0; x < width; x++) {
    seed(x, 0);
    seed(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    seed(0, y);
    seed(width - 1, y);
  }

  // Flood OPEN cells outward (4-connected) from the boundary seeds.
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const x = i % width;
    const y = (i - x) / width;
    // West / East / North / South.
    if (x > 0) seed(x - 1, y);
    if (x < width - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < height - 1) seed(x, y + 1);
  }

  // Any OPEN cell the flood never reached is sealed inside walls.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (grid.isWall(x, y)) continue;
      if (reached[idx(x, y)]) continue;
      enclosed.add(cellKey(x, y));
    }
  }
  return enclosed;
}

/**
 * Convenience builder: wrap a flat wall buffer as a {@link WallGrid}. `walls`
 * is row-major `width × height`; a non-zero entry is a wall. Out-of-bounds
 * reads count as OPEN (so the flood treats the world beyond the grid as the
 * outside it leaks to) — the detector never queries out of bounds, but keeping
 * the view total makes it safe to reuse elsewhere.
 */
export function wallGridFromBuffer(
  walls: Uint8Array,
  width: number,
  height: number,
): WallGrid {
  return {
    width,
    height,
    isWall(x: number, y: number): boolean {
      if (x < 0 || x >= width || y < 0 || y >= height) return false;
      return walls[x + y * width] !== 0;
    },
  };
}
