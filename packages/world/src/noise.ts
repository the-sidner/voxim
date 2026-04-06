/**
 * 2D seeded value noise for terrain generation.
 *
 * Implements FBM (Fractional Brownian Motion) over a 2D value noise base.
 * No external dependencies — pure arithmetic, deterministic given a seed.
 *
 * Not cryptographically secure; game-quality randomness only.
 */

/**
 * Integer hash returning a value in [0, 1).
 * Passes basic visual quality tests for terrain use.
 */
export function hash2(ix: number, iy: number, seed: number): number {
  let n = (((ix * 1619) ^ (iy * 31337)) + seed * 6271) | 0;
  n = ((n << 13) ^ n) | 0;
  return (((n * ((n * n * 15731 + 789221) | 0) + 1376312589) | 0) & 0x7fffffff) / 2147483648.0;
}

/** Quintic smoothstep — C2 continuous, better than linear or cubic. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 2D value noise at position (x, y) with the given seed.
 * Returns a value in [0, 1).
 */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const tx = fade(xf);
  const ty = fade(yf);

  const v00 = hash2(xi,     yi,     seed);
  const v10 = hash2(xi + 1, yi,     seed);
  const v01 = hash2(xi,     yi + 1, seed);
  const v11 = hash2(xi + 1, yi + 1, seed);

  return v00 * (1 - tx) * (1 - ty)
       + v10 * tx       * (1 - ty)
       + v01 * (1 - tx) * ty
       + v11 * tx       * ty;
}

/**
 * Fractional Brownian Motion — sums `octaves` layers of noise at increasing
 * frequencies and decreasing amplitudes.  Returns a value in [0, 1].
 *
 * @param x        World-space X, pre-scaled by the base frequency.
 * @param y        World-space Y.
 * @param seed     Deterministic seed.
 * @param octaves  Number of octave layers (4–6 for terrain).
 * @param lacunarity  Frequency multiplier per octave (default 2.0).
 * @param gain        Amplitude multiplier per octave (default 0.5 = -6 dB).
 */
export function fbm(
  x: number,
  y: number,
  seed: number,
  octaves: number,
  lacunarity = 2.0,
  gain = 0.5,
): number {
  let value = 0;
  let amplitude = 1.0;
  let totalAmplitude = 0;
  let freq = 1.0;

  for (let i = 0; i < octaves; i++) {
    value += amplitude * valueNoise2D(x * freq, y * freq, seed + i * 13337);
    totalAmplitude += amplitude;
    amplitude *= gain;
    freq *= lacunarity;
  }
  return value / totalAmplitude;
}

/**
 * Ridged multi-fractal noise — produces sharp mountain ridge features.
 *
 * Each octave applies a fold so the highest values become peaks and the
 * noise oscillates around them with weight-based inter-octave coupling.
 *
 * Returns a value approximately in [0, 1].
 */
export function ridgedFbm(
  x: number,
  y: number,
  seed: number,
  octaves: number,
  lacunarity = 2.0,
  gain = 0.5,
  ridgeOffset = 1.0,
): number {
  let value = 0;
  let amplitude = 1.0;
  let totalAmplitude = 0;
  let freq = 1.0;
  let weight = 1.0;

  for (let i = 0; i < octaves; i++) {
    // Raw noise mapped to [-1, 1], folded into ridges
    const raw = valueNoise2D(x * freq, y * freq, seed + i * 13337) * 2 - 1;
    let n = ridgeOffset - Math.abs(raw);
    n = n * n;
    n *= weight;

    value += amplitude * n;
    totalAmplitude += amplitude;

    // Next octave's weight is driven by this octave's ridge value
    weight = Math.max(0, Math.min(1, n));

    amplitude *= gain;
    freq *= lacunarity;
  }
  return totalAmplitude > 0 ? value / totalAmplitude : 0;
}

/**
 * Billow FBM — abs-value folded noise producing soft, rounded hill shapes.
 *
 * Returns a value approximately in [0, 1].
 */
export function billowFbm(
  x: number,
  y: number,
  seed: number,
  octaves: number,
  lacunarity = 2.0,
  gain = 0.5,
): number {
  let value = 0;
  let amplitude = 1.0;
  let totalAmplitude = 0;
  let freq = 1.0;

  for (let i = 0; i < octaves; i++) {
    const raw = valueNoise2D(x * freq, y * freq, seed + i * 13337) * 2 - 1;
    value += amplitude * Math.abs(raw);
    totalAmplitude += amplitude;
    amplitude *= gain;
    freq *= lacunarity;
  }
  return totalAmplitude > 0 ? value / totalAmplitude : 0;
}

/**
 * Domain warp — distorts input coordinates using FBM offsets, producing
 * organic-looking terrain features like overhanging cliffs and curling rivers.
 *
 * @param x        World X.
 * @param y        World Y.
 * @param seed     Seed passed to the warp FBM.
 * @param octaves  FBM octave count for the warp field.
 * @param freq     Base frequency for the warp noise.
 * @param amp      World-space warp amplitude (units of displacement).
 * @returns        Warped [x, y] coordinates.
 */
export function domainWarp(
  x: number,
  y: number,
  seed: number,
  octaves: number,
  freq: number,
  amp: number,
): [number, number] {
  const warpX = fbm(x * freq,       y * freq,       seed,        octaves) * amp;
  const warpY = fbm(x * freq + 5.2, y * freq + 1.3, seed + 1000, octaves) * amp;
  return [x + warpX, y + warpY];
}

/**
 * Voronoi (cellular) noise — returns the distance to the nearest feature point
 * in a jittered grid of cells.
 *
 * Returns a value in [0, 1].
 */
export function voronoi2D(x: number, y: number, seed: number): number {
  const cx0 = Math.floor(x);
  const cy0 = Math.floor(y);

  let minDist = Infinity;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = cx0 + dx;
      const cy = cy0 + dy;

      // Feature point inside this cell — jitter via hash2
      const fx = cx + hash2(cx, cy, seed);
      const fy = cy + hash2(cx, cy, seed + 7777);

      const ddx = x - fx;
      const ddy = y - fy;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);

      if (dist < minDist) minDist = dist;
    }
  }

  // Max possible distance to a feature point in a 3×3 neighbourhood is ~√2
  return Math.max(0, Math.min(1, minDist));
}
