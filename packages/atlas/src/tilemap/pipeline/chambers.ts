/**
 * Stage 2 — chambers (replaces the old roomify stage).
 *
 * Two-phase deterministic chamber placement:
 *
 *   1. Poisson-disk sampling places `targetCount` seed pixels with a min
 *      separation of `minSeparation` pixels (Bridson-style: each accepted
 *      seed seeds k=30 candidate points in its annulus; one is accepted
 *      if it clears all existing seeds). Stops when count is hit or no
 *      new candidate fits — in dense tiles you usually get the full
 *      target; on tiles already crowded (rivers, gates) you may get
 *      slightly fewer.
 *
 *   2. Priority-flood growth: every chamber's seed pixel is the root of
 *      a min-heap keyed by `noise[p] + compactness · |p − seed|` at the
 *      candidate pixel. We round-robin one pixel per chamber per round,
 *      always popping the lowest-cost neighbour. The noise term gives
 *      organic outline detail; the distance term keeps chambers
 *      accreting volume around their seed instead of stretching into
 *      thin noise lobes. Round-robin makes adjacent chambers compete
 *      fairly for shared territory.
 *
 * Each chamber stops when it reaches its randomly-picked target size
 * (in [sizeMin, sizeMax]) or runs out of un-claimed neighbours.
 *
 * Outputs: `openMask` (1 = open, all chamber pixels), `chamberOf`
 * (Uint16 chamber id per pixel; 0xFFFF for closed), `chambers[]` (with
 * centroid + pixel count).
 */

import { ROOM_ID_NONE } from "./room_detection.ts";
import type { Room } from "../types.ts";
import type { GenParams } from "../../genparams.ts";

export interface ChambersInput {
  noiseField: Float32Array;
  gridSize: number;
  /** World units per pixel. */
  px2world: number;
  tileSeed: number;
  params: GenParams["room"];
}

export interface ChambersOutput {
  openMask: Uint8Array;
  chamberOf: Uint16Array;
  chambers: Room[];
}

const CHAMBERS_SUB_SEED = 0xC4A33500;
const POISSON_K = 30;

export function runChambers(input: ChambersInput): ChambersOutput {
  const { noiseField, gridSize, px2world, tileSeed, params } = input;
  const N = gridSize * gridSize;
  const openMask  = new Uint8Array(N);
  const chamberOf = new Uint16Array(N).fill(ROOM_ID_NONE);

  const rng = mulberry32(tileSeed ^ CHAMBERS_SUB_SEED);

  // ---- 1. Poisson-disk seeds --------------------------------------------
  const seeds = poissonSeeds(
    gridSize, params.targetCount, params.minSeparation, rng,
  );
  if (seeds.length === 0) {
    return { openMask, chamberOf, chambers: [] };
  }

  // ---- 2. Priority-flood growth -----------------------------------------
  // One min-heap of candidate (noiseValue, pixelIdx) per chamber. Each
  // chamber gets one pixel per round.
  const heaps: MinHeap[] = seeds.map(() => new MinHeap());
  const sizes:   number[] = new Array(seeds.length).fill(0);
  const targets: number[] = seeds.map(() =>
    Math.round(params.sizeMin + rng() * (params.sizeMax - params.sizeMin)),
  );
  const sumX: number[] = new Array(seeds.length).fill(0);
  const sumY: number[] = new Array(seeds.length).fill(0);
  const done:  boolean[] = new Array(seeds.length).fill(false);

  // Seed every chamber with its starting pixel. Compactness multiplies a
  // distance term measured in WORLD UNITS (not pixels) so the knob means
  // the same thing regardless of gridSize.
  const compactnessPerPx = params.compactness * px2world;
  for (let c = 0; c < seeds.length; c++) {
    const idx = seeds[c].y * gridSize + seeds[c].x;
    openMask[idx]  = 1;
    chamberOf[idx] = c;
    sizes[c]++;
    sumX[c] += seeds[c].x;
    sumY[c] += seeds[c].y;
    pushNeighbours(heaps[c], idx, gridSize, noiseField, chamberOf, seeds[c], compactnessPerPx);
  }

  // Round-robin until everyone is full or stuck.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let c = 0; c < seeds.length; c++) {
      if (done[c]) continue;
      if (sizes[c] >= targets[c]) { done[c] = true; continue; }
      // Pop until we find a still-claimable pixel (or empty).
      let placed = false;
      while (heaps[c].size() > 0) {
        const idx = heaps[c].pop();
        if (chamberOf[idx] !== ROOM_ID_NONE) continue; // someone else got it first
        openMask[idx]  = 1;
        chamberOf[idx] = c;
        sizes[c]++;
        const x = idx % gridSize;
        const y = (idx - x) / gridSize;
        sumX[c] += x;
        sumY[c] += y;
        pushNeighbours(heaps[c], idx, gridSize, noiseField, chamberOf, seeds[c], compactnessPerPx);
        placed = true;
        progressed = true;
        break;
      }
      if (!placed) done[c] = true;
    }
  }

  // ---- 3. Build Room records --------------------------------------------
  const chambers: Room[] = [];
  for (let c = 0; c < seeds.length; c++) {
    chambers.push({
      id: c,
      cx: (sumX[c] / sizes[c] + 0.5) * px2world,
      cy: (sumY[c] / sizes[c] + 0.5) * px2world,
      pixelCount: sizes[c],
    });
  }

  return { openMask, chamberOf, chambers };
}

// ============================================================================
// Helpers
// ============================================================================

function pushNeighbours(
  heap: MinHeap, idx: number, gridSize: number,
  noiseField: Float32Array, chamberOf: Uint16Array,
  seed: { x: number; y: number }, compactnessPerPx: number,
): void {
  const x = idx % gridSize;
  const y = (idx - x) / gridSize;
  const candidates = [
    x > 0              ? idx - 1        : -1,
    x < gridSize - 1   ? idx + 1        : -1,
    y > 0              ? idx - gridSize : -1,
    y < gridSize - 1   ? idx + gridSize : -1,
  ];
  for (const nb of candidates) {
    if (nb < 0) continue;
    if (chamberOf[nb] !== ROOM_ID_NONE) continue;
    const nx = nb % gridSize;
    const ny = (nb - nx) / gridSize;
    const dx = nx - seed.x;
    const dy = ny - seed.y;
    const dist = Math.hypot(dx, dy);
    heap.push(nb, noiseField[nb] + compactnessPerPx * dist);
  }
}

/**
 * Bridson-style Poisson-disk sampling on a pixel grid. Returns up to
 * `target` points each at least `minSeparation` pixels from any other.
 *
 * Background-grid acceleration: cells of side r/√2 hold at most one
 * sample, so neighbour checks are O(1) per candidate.
 */
function poissonSeeds(
  gridSize: number, target: number, minSeparation: number, rng: () => number,
): Array<{ x: number; y: number }> {
  const r = Math.max(1, minSeparation);
  const cellSize = r / Math.SQRT2;
  const cols = Math.ceil(gridSize / cellSize);
  const rows = Math.ceil(gridSize / cellSize);
  const grid: Int32Array = new Int32Array(cols * rows).fill(-1);
  const samples: Array<{ x: number; y: number }> = [];
  const active: number[] = [];

  const insert = (x: number, y: number): boolean => {
    if (samples.length >= target) return false;
    if (x < 0 || y < 0 || x >= gridSize || y >= gridSize) return false;
    const gx = Math.floor(x / cellSize);
    const gy = Math.floor(y / cellSize);
    // Check 5x5 background neighbourhood for any too-close existing sample.
    const x0 = Math.max(0, gx - 2), x1 = Math.min(cols - 1, gx + 2);
    const y0 = Math.max(0, gy - 2), y1 = Math.min(rows - 1, gy + 2);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const sIdx = grid[yy * cols + xx];
        if (sIdx < 0) continue;
        const s = samples[sIdx];
        const dx = s.x - x, dy = s.y - y;
        if (dx * dx + dy * dy < r * r) return false;
      }
    }
    grid[gy * cols + gx] = samples.length;
    samples.push({ x, y });
    active.push(samples.length - 1);
    return true;
  };

  // Initial seed: jitter from the centre so determinism is consistent
  // regardless of the jitter PRNG draw count.
  insert(
    Math.floor(rng() * gridSize),
    Math.floor(rng() * gridSize),
  );

  while (active.length > 0 && samples.length < target) {
    const aIdx = Math.floor(rng() * active.length);
    const sIdx = active[aIdx];
    const s = samples[sIdx];
    let placed = false;
    for (let attempt = 0; attempt < POISSON_K; attempt++) {
      const angle = rng() * Math.PI * 2;
      const dist  = r + rng() * r;       // annulus [r, 2r]
      const x = Math.round(s.x + Math.cos(angle) * dist);
      const y = Math.round(s.y + Math.sin(angle) * dist);
      if (insert(x, y)) { placed = true; break; }
    }
    if (!placed) {
      // Remove this seed from active set (swap-pop).
      active[aIdx] = active[active.length - 1];
      active.pop();
    }
  }

  return samples;
}

class MinHeap {
  private idx: number[] = [];
  private key: number[] = [];
  size(): number { return this.idx.length; }
  push(node: number, key: number): void {
    this.idx.push(node);
    this.key.push(key);
    this.siftUp(this.idx.length - 1);
  }
  pop(): number {
    const top = this.idx[0];
    const lastNode = this.idx.pop()!;
    const lastKey  = this.key.pop()!;
    if (this.idx.length > 0) {
      this.idx[0] = lastNode;
      this.key[0] = lastKey;
      this.siftDown(0);
    }
    return top;
  }
  private siftUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.key[p] <= this.key[i]) break;
      this.swap(i, p); i = p;
    }
  }
  private siftDown(i: number): void {
    const n = this.idx.length;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let s = i;
      if (l < n && this.key[l] < this.key[s]) s = l;
      if (r < n && this.key[r] < this.key[s]) s = r;
      if (s === i) break;
      this.swap(i, s); i = s;
    }
  }
  private swap(i: number, j: number): void {
    const tn = this.idx[i]; this.idx[i] = this.idx[j]; this.idx[j] = tn;
    const tk = this.key[i]; this.key[i] = this.key[j]; this.key[j] = tk;
  }
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
