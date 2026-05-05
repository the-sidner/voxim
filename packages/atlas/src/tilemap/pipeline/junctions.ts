/**
 * Stage 2 — junctions.
 *
 * Poisson-disk-sampled point set across the tile. These are the graph
 * nodes the network stage builds Delaunay over; carved corridors land
 * at junction positions. They are NOT yet rooms — most will end up as
 * invisible bends in the corridor; only convergent ones (high degree
 * after the network stage decides which Delaunay edges to keep) get a
 * small noise-flooded room grown around them in the rooms stage.
 *
 * Bridson-style sampler with k=30 candidate angles per active seed and
 * a background-grid acceleration (cells of side r/√2). Deterministic
 * via tile-seeded mulberry32 PRNG.
 */
import type { GenParams } from "../../genparams.ts";

export interface Junction {
  /** Pixel coords. */
  x: number;
  y: number;
}

export interface JunctionsInput {
  gridSize: number;
  tileSeed: number;
  params: GenParams["room"];
}

export interface JunctionsOutput {
  seeds: Junction[];
}

const JUNCTIONS_SUB_SEED = 0x10C73101;
const POISSON_K = 30;

export function runJunctions(input: JunctionsInput): JunctionsOutput {
  const { gridSize, tileSeed, params } = input;
  const rng = mulberry32(tileSeed ^ JUNCTIONS_SUB_SEED);
  const seeds = poissonSeeds(gridSize, params.targetCount, params.minSeparation, rng);
  return { seeds };
}

/**
 * Bridson Poisson-disk sampling on a pixel grid. Returns up to `target`
 * points each at least `minSeparation` pixels from any other.
 */
function poissonSeeds(
  gridSize: number, target: number, minSeparation: number, rng: () => number,
): Junction[] {
  const r = Math.max(1, minSeparation);
  const cellSize = r / Math.SQRT2;
  const cols = Math.ceil(gridSize / cellSize);
  const rows = Math.ceil(gridSize / cellSize);
  const grid = new Int32Array(cols * rows).fill(-1);
  const samples: Junction[] = [];
  const active: number[] = [];

  const insert = (x: number, y: number): boolean => {
    if (samples.length >= target) return false;
    if (x < 0 || y < 0 || x >= gridSize || y >= gridSize) return false;
    const gx = Math.floor(x / cellSize);
    const gy = Math.floor(y / cellSize);
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

  insert(Math.floor(rng() * gridSize), Math.floor(rng() * gridSize));

  while (active.length > 0 && samples.length < target) {
    const aIdx = Math.floor(rng() * active.length);
    const sIdx = active[aIdx];
    const s = samples[sIdx];
    let placed = false;
    for (let attempt = 0; attempt < POISSON_K; attempt++) {
      const angle = rng() * Math.PI * 2;
      const dist  = r + rng() * r;
      const x = Math.round(s.x + Math.cos(angle) * dist);
      const y = Math.round(s.y + Math.sin(angle) * dist);
      if (insert(x, y)) { placed = true; break; }
    }
    if (!placed) {
      active[aIdx] = active[active.length - 1];
      active.pop();
    }
  }

  return samples;
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
