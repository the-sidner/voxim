/**
 * Stage 4 — rooms (post-network).
 *
 * After the network stage has carved corridors, we walk every junction
 * and probabilistically promote it to a *room*: a small noise-flooded
 * disk grown around its seed pixel. The probability scales with the
 * junction's degree (count of network edges incident on it) so true
 * convergence points get rooms reliably; pass-through bends rarely do.
 *
 *   prob = clamp(roomChanceBase + (degree − 1) · roomChancePerDegree, 0, 1)
 *
 * Growth uses the same priority-flood as the old chambers stage:
 * round-robin one pixel per chosen room per round, picking the lowest
 * `noise + compactness · |p − seed|` candidate. This gives organic,
 * gridSize-invariant shapes that absorb whatever the corridor entries
 * happen to land on (so the room visibly *swells* around its junction,
 * including the corridor-entry pixels).
 *
 * Output mirrors the old chambers stage: `chambers[]` (one per grown
 * room with id/centroid/pixelCount) and `chamberOf[]` (per-pixel id;
 * 0xFFFF for non-room pixels). Wire shape unchanged.
 */

import type { Transformer } from "@voxim/levelgen";
import { ROOM_ID_NONE } from "./room_detection.ts";
import type { Junction } from "./junctions.ts";
import type { Room } from "../types.ts";
import type { GenParams } from "../../genparams.ts";
import type { NetworkState, RoomsState } from "./state.ts";

const ROOMS_SUB_SEED = 0xC4A33500;

export const rooms: Transformer<NetworkState, RoomsState, GenParams["room"]> =
  (state, seed, params) => {
    const { openMask, noiseField, seeds, degrees, gridSize, px2world } = state;
    const N = gridSize * gridSize;
    const chamberOf = new Uint16Array(N).fill(ROOM_ID_NONE);

    const rng = mulberry32(seed ^ ROOMS_SUB_SEED);

  // ---- 1. Decide which junctions become rooms ----------------------------
  // Per-junction roll. Higher degree = higher chance. The roll happens
  // BEFORE size selection so we don't waste PRNG draws on junctions that
  // get rejected.
  type Pick = { seed: Junction; chamberId: number; target: number };
  const picks: Pick[] = [];
  for (let i = 0; i < seeds.length; i++) {
    const deg = degrees[i];
    const prob = Math.min(1, Math.max(0, params.roomChanceBase + (deg - 1) * params.roomChancePerDegree));
    if (rng() >= prob) continue;
    const target = Math.round(params.sizeMin + rng() * (params.sizeMax - params.sizeMin));
    picks.push({ seed: seeds[i], chamberId: picks.length, target });
  }

  if (picks.length === 0) {
    return { ...state, chamberOf, chambers: [] };
  }

  // ---- 2. Priority-flood growth (round-robin among picks) ----------------
  const compactnessPerPx = params.compactness * px2world;
  const heaps:   MinHeap[] = picks.map(() => new MinHeap());
  const sizes:   number[]  = new Array(picks.length).fill(0);
  const sumX:    number[]  = new Array(picks.length).fill(0);
  const sumY:    number[]  = new Array(picks.length).fill(0);
  const done:    boolean[] = new Array(picks.length).fill(false);

  // Seed each room with its junction pixel.
  for (let c = 0; c < picks.length; c++) {
    const { seed } = picks[c];
    const idx = seed.y * gridSize + seed.x;
    openMask[idx]  = 1;
    chamberOf[idx] = c;
    sizes[c]++;
    sumX[c] += seed.x;
    sumY[c] += seed.y;
    pushNeighbours(heaps[c], idx, gridSize, noiseField, chamberOf, seed, compactnessPerPx);
  }

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let c = 0; c < picks.length; c++) {
      if (done[c]) continue;
      if (sizes[c] >= picks[c].target) { done[c] = true; continue; }
      let placed = false;
      while (heaps[c].size() > 0) {
        const idx = heaps[c].pop();
        if (chamberOf[idx] !== ROOM_ID_NONE) continue;
        openMask[idx]  = 1;
        chamberOf[idx] = c;
        sizes[c]++;
        const x = idx % gridSize;
        const y = (idx - x) / gridSize;
        sumX[c] += x;
        sumY[c] += y;
        pushNeighbours(heaps[c], idx, gridSize, noiseField, chamberOf, picks[c].seed, compactnessPerPx);
        placed = true;
        progressed = true;
        break;
      }
      if (!placed) done[c] = true;
    }
  }

  // ---- 3. Build Room records --------------------------------------------
  const chambers: Room[] = [];
  for (let c = 0; c < picks.length; c++) {
    chambers.push({
      id: c,
      cx: (sumX[c] / sizes[c] + 0.5) * px2world,
      cy: (sumY[c] / sizes[c] + 0.5) * px2world,
      pixelCount: sizes[c],
    });
  }

  return { ...state, chamberOf, chambers };
};

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
