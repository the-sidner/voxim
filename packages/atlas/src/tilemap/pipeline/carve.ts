/**
 * Shared corridor-carving helpers.
 *
 * Used by the network stage (room↔room corridors) and the portal-placement
 * stage (gate→nearest-room corridors). Same A* + cost model so all corridors
 * in the tile look like they belong to one system.
 *
 * Cost model (per-cell movement):
 *   open cell    → 0.5   (passing through existing rooms is nearly free)
 *   closed cell  → 1 + noiseCostScale * max(0, noiseValue - threshold)
 *
 * So the search prefers existing rooms, then the weakest walls; deep-inside-
 * wall pixels are expensive and avoided. Result: corridors meander along
 * noise-thin regions instead of cutting straight lines through rock.
 */

export interface CarveContext {
  openMask: Uint8Array;
  noiseField: Float32Array;
  threshold: number;
  gridSize: number;
  noiseCostScale: number;
  /** Chebyshev half-width for the carved brush. 0 = 1px wide, 1 = 3px, … */
  corridorWidth: number;
}

/**
 * A* from (ax, ay) to (bx, by) under the noise-flow cost. Returns the
 * cell-index path or null if no path exists (shouldn't happen on a finite
 * grid where every cell is reachable in principle).
 */
export function aStarNoiseFlow(
  ax: number, ay: number, bx: number, by: number, ctx: CarveContext,
): number[] | null {
  const { openMask, noiseField, threshold, gridSize, noiseCostScale } = ctx;
  const N = gridSize * gridSize;
  const start = ay * gridSize + ax;
  const goal  = by * gridSize + bx;
  if (start === goal) return [start];

  const gScore = new Float64Array(N).fill(Infinity);
  const cameFrom = new Int32Array(N).fill(-1);
  gScore[start] = 0;

  const heap = new MinHeap();
  heap.push(start, heuristic(ax, ay, bx, by));

  while (heap.size() > 0) {
    const cur = heap.pop();
    if (cur === goal) {
      const path: number[] = [];
      let n = cur;
      while (n !== -1) { path.push(n); n = cameFrom[n]; }
      path.reverse();
      return path;
    }
    const cx = cur % gridSize;
    const cy = (cur - cx) / gridSize;
    const candidates = [
      cx > 0              ? cur - 1        : -1,
      cx < gridSize - 1   ? cur + 1        : -1,
      cy > 0              ? cur - gridSize : -1,
      cy < gridSize - 1   ? cur + gridSize : -1,
    ];
    for (const nb of candidates) {
      if (nb < 0) continue;
      const stepCost = openMask[nb] === 1
        ? 0.5
        : 1 + noiseCostScale * Math.max(0, noiseField[nb] - threshold);
      const tentative = gScore[cur] + stepCost;
      if (tentative >= gScore[nb]) continue;
      cameFrom[nb] = cur;
      gScore[nb] = tentative;
      const nx = nb % gridSize;
      const ny = (nb - nx) / gridSize;
      heap.push(nb, tentative + heuristic(nx, ny, bx, by));
    }
  }
  return null;
}

/**
 * Plan + carve in one call. Returns true on success, false if no path.
 * Mutates `ctx.openMask`.
 */
export function carveCorridor(
  ax: number, ay: number, bx: number, by: number, ctx: CarveContext,
): boolean {
  const path = aStarNoiseFlow(ax, ay, bx, by, ctx);
  if (!path) return false;
  carvePath(path, ctx.openMask, ctx.gridSize, ctx.corridorWidth);
  return true;
}

/**
 * Open every pixel along `path`, expanded by `halfWidth` cells in Chebyshev
 * distance.
 */
export function carvePath(
  path: number[], openMask: Uint8Array, gridSize: number, halfWidth: number,
): void {
  for (const idx of path) {
    const cx = idx % gridSize;
    const cy = (idx - cx) / gridSize;
    const x0 = Math.max(0, cx - halfWidth);
    const x1 = Math.min(gridSize - 1, cx + halfWidth);
    const y0 = Math.max(0, cy - halfWidth);
    const y1 = Math.min(gridSize - 1, cy + halfWidth);
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        openMask[py * gridSize + px] = 1;
      }
    }
  }
}

export function clampPx(v: number, gridSize: number): number {
  return v < 0 ? 0 : v >= gridSize ? gridSize - 1 : v;
}

function heuristic(ax: number, ay: number, bx: number, by: number): number {
  // Admissible: cheapest possible step is 0.5 (passing through open cells),
  // so the heuristic must scale by ≤ 0.5 per Manhattan step.
  return 0.5 * (Math.abs(ax - bx) + Math.abs(ay - by));
}

class MinHeap {
  private nodes: number[] = [];
  private keys:  number[] = [];
  size(): number { return this.nodes.length; }
  push(node: number, key: number): void {
    this.nodes.push(node);
    this.keys.push(key);
    this.siftUp(this.nodes.length - 1);
  }
  pop(): number {
    const top = this.nodes[0];
    const lastNode = this.nodes.pop()!;
    const lastKey  = this.keys.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastNode;
      this.keys[0]  = lastKey;
      this.siftDown(0);
    }
    return top;
  }
  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  private siftDown(i: number): void {
    const n = this.nodes.length;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.keys[l] < this.keys[smallest]) smallest = l;
      if (r < n && this.keys[r] < this.keys[smallest]) smallest = r;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }
  private swap(i: number, j: number): void {
    const tn = this.nodes[i]; this.nodes[i] = this.nodes[j]; this.nodes[j] = tn;
    const tk = this.keys[i];  this.keys[i]  = this.keys[j];  this.keys[j]  = tk;
  }
}
