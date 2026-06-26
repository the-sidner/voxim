/**
 * Procedural voxel textures — one per material type.
 *
 * Textures are generated at startup using Canvas 2D + a seeded PRNG.
 * They are 32×32, tileable, and designed to add grain/detail within each
 * voxel face without overwhelming the colour identity of the material.
 *
 * Usage:
 *   const tex = getVoxelTexture(matId, colorHex);
 *   // tex is a THREE.CanvasTexture (or null to fall back to flat colour)
 */

import * as THREE from "three";

// ---- seeded PRNG (mulberry32) -----------------------------------------------

function makePrng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- colour helpers ---------------------------------------------------------

function hexToRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

/** Clamp to [0,255] integer. */
function clamp8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function rgba(r: number, g: number, b: number, a = 255): string {
  return `rgba(${clamp8(r)},${clamp8(g)},${clamp8(b)},${a / 255})`;
}

/** Brighten or darken a colour by `amount` (-1 → -100%, +1 → +100%). */
function adjust(r: number, g: number, b: number, amount: number): string {
  return rgba(r + r * amount, g + g * amount, b + b * amount);
}

// ---- canvas texture factory -------------------------------------------------

function makeTex(
  draw: (ctx: CanvasRenderingContext2D, rng: () => number, r: number, g: number, b: number) => void,
  r: number, g: number, b: number,
  seed: number,
  size = 32,
): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  draw(ctx, makePrng(seed), r, g, b);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- texture generators -----------------------------------------------------

/** Build an n×n value-noise lattice in [0,1] for tileable low-frequency variation. */
function makeNoiseGrid(rng: () => number, n: number): Float32Array {
  const g = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) g[i] = rng();
  return g;
}

/** Bilinear sample of an n×n lattice with wrap-around (tileable) at (fx, fy) in
 *  lattice units. */
function sampleTileable(grid: Float32Array, n: number, fx: number, fy: number): number {
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const xa = ((x0 % n) + n) % n, xb = (xa + 1) % n;
  const ya = ((y0 % n) + n) % n, yb = (ya + 1) % n;
  const v00 = grid[ya * n + xa], v10 = grid[ya * n + xb];
  const v01 = grid[yb * n + xa], v11 = grid[yb * n + xb];
  const a = v00 + (v10 - v00) * tx;
  const b = v01 + (v11 - v01) * tx;
  return a + (b - a) * ty;
}

/**
 * Fill with base colour then layer two scales of variation: a smooth tileable
 * value-noise (large organic patches — the "detail" read that keeps a flat voxel
 * face from looking like a single uniform swatch) plus the fine per-pixel grain.
 */
function drawNoise(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  r: number, g: number, b: number,
  amount: number,   // ±fraction fine-grain variation
  size = 32,
): void {
  ctx.fillStyle = rgba(r, g, b);
  ctx.fillRect(0, 0, size, size);
  const N = 4;                       // low-freq lattice → ~8px patches at 32px
  const lf = makeNoiseGrid(rng, N);
  const lowAmount = amount * 0.6;    // patch contrast, relative to the fine grain
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const patch = (sampleTileable(lf, N, (x / size) * N, (y / size) * N) - 0.5) * 2 * lowAmount;
      const grain = (rng() - 0.5) * 2 * amount;
      const v = patch + grain;
      d[i * 4    ] = clamp8(r + r * v);
      d[i * 4 + 1] = clamp8(g + g * v);
      d[i * 4 + 2] = clamp8(b + b * v);
      d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Wood grain — vertical streaks with horizontal noise. */
function drawWood(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  r: number, g: number, b: number,
): void {
  const S = 32;
  const img = ctx.getImageData(0, 0, S, S) || (() => {
    ctx.fillStyle = rgba(r, g, b);
    ctx.fillRect(0, 0, S, S);
    return ctx.getImageData(0, 0, S, S);
  })();
  ctx.fillStyle = rgba(r, g, b);
  ctx.fillRect(0, 0, S, S);
  const d = ctx.getImageData(0, 0, S, S).data;
  const imgData = ctx.createImageData(S, S);
  const o = imgData.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // Grain: sine along X with noise offset
      const noiseOffset = (rng() - 0.5) * 4;
      const grain = Math.sin((x + noiseOffset) * 0.8) * 0.5 + 0.5; // 0–1
      // Bright streaks on darker base
      const v = grain * 0.2 - 0.05 + (rng() - 0.5) * 0.08;
      const i = (y * S + x) * 4;
      o[i    ] = clamp8(r + r * v);
      o[i + 1] = clamp8(g + g * v);
      o[i + 2] = clamp8(b + b * v);
      o[i + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

/** Stone — speckled with subtle rectangular "block" pattern. */
function drawStone(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  r: number, g: number, b: number,
): void {
  const S = 32;
  const img = ctx.createImageData(S, S);
  const o = img.data;
  const N = 4;
  const lf = makeNoiseGrid(rng, N);   // large weathered patches across the stone
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // Subtle speckle noise
      const n = (rng() - 0.5) * 0.25;
      // Large-scale weathering/stain patches
      const patch = (sampleTileable(lf, N, (x / S) * N, (y / S) * N) - 0.5) * 0.18;
      // Faint "block edge" lines every 8 px to suggest masonry
      const edge = (x % 8 === 0 || y % 8 === 0) ? -0.12 : 0;
      const v = n + patch + edge;
      const i = (y * S + x) * 4;
      o[i    ] = clamp8(r + r * v);
      o[i + 1] = clamp8(g + g * v);
      o[i + 2] = clamp8(b + b * v);
      o[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Organic material (grass, leaves, fur) — stippled noise. */
function drawOrganic(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  r: number, g: number, b: number,
  amount = 0.25,
): void {
  drawNoise(ctx, rng, r, g, b, amount);
}

/** Metallic material — subtle diagonal sheen. */
function drawMetal(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  r: number, g: number, b: number,
): void {
  const S = 32;
  const img = ctx.createImageData(S, S);
  const o = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const sheen = Math.sin((x - y) * 0.4) * 0.08;
      const n = (rng() - 0.5) * 0.06;
      const v = sheen + n;
      const i = (y * S + x) * 4;
      o[i    ] = clamp8(r + r * v);
      o[i + 1] = clamp8(g + g * v);
      o[i + 2] = clamp8(b + b * v);
      o[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Dirt / mud — lumpy noise with slightly dark patches. */
function drawDirt(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  r: number, g: number, b: number,
): void {
  drawNoise(ctx, rng, r, g, b, 0.2);
}

/** Sand — warm fine grain. */
function drawSand(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  r: number, g: number, b: number,
): void {
  drawNoise(ctx, rng, r, g, b, 0.12);
}

/** Leather — horizontal lines + noise. */
function drawLeather(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  r: number, g: number, b: number,
): void {
  const S = 32;
  const img = ctx.createImageData(S, S);
  const o = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const line = (y % 4 === 0) ? -0.12 : 0;
      const n = (rng() - 0.5) * 0.15;
      const v = line + n;
      const i = (y * S + x) * 4;
      o[i    ] = clamp8(r + r * v);
      o[i + 1] = clamp8(g + g * v);
      o[i + 2] = clamp8(b + b * v);
      o[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Bone — off-white with faint longitudinal groove. */
function drawBone(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  r: number, g: number, b: number,
): void {
  const S = 32;
  const img = ctx.createImageData(S, S);
  const o = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const groove = Math.abs(x - S / 2) < 2 ? -0.1 : 0;
      const n = (rng() - 0.5) * 0.08;
      const v = groove + n;
      const i = (y * S + x) * 4;
      o[i    ] = clamp8(r + r * v);
      o[i + 1] = clamp8(g + g * v);
      o[i + 2] = clamp8(b + b * v);
      o[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ---- public API -------------------------------------------------------------

type DrawFn = (
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  r: number, g: number, b: number,
) => void;

/** Per-material-ID draw function. Materials not listed get flat colour. */
const DRAW_FN: Record<number, DrawFn> = {
  1:   drawOrganic,  // grass
  2:   drawWood,     // wood
  3:   drawStone,    // stone
  4:   drawDirt,     // dirt
  5:   drawSand,     // sand
  6:   drawMetal,    // iron
  7:   drawOrganic,  // torch (emissive orange)
  9:   drawOrganic,  // corrupted
  11:  drawDirt,     // mud
  12:  drawStone,    // gravel
  100: drawWood,     // oak
  101: drawWood,     // pine
  102: drawLeather,  // leather
  103: drawMetal,    // steel
  104: drawMetal,    // copper
  105: drawBone,     // bone
  200: drawOrganic,  // wolf_fur_dark
  201: drawOrganic,  // wolf_fur_light
};

const cache = new Map<number, THREE.CanvasTexture>();

/**
 * Return a procedural texture for the given material ID.
 * Results are cached — the same texture instance is reused across all meshes.
 * Returns null for material IDs with no generator (fall back to flat colour).
 */
export function getVoxelTexture(matId: number, color: number): THREE.CanvasTexture | null {
  if (cache.has(matId)) return cache.get(matId)!;

  const fn = DRAW_FN[matId];
  if (!fn) return null;

  const [r, g, b] = hexToRgb(color);
  const tex = makeTex(fn, r, g, b, matId * 1234567 + 42);
  cache.set(matId, tex);
  return tex;
}

export function disposeVoxelTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
