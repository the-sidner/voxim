/**
 * 2D seeded value noise — local copy.
 *
 * Vendored verbatim from packages/world/src/noise.ts so atlas has no
 * runtime dependency on @voxim/world. When packages/world folds into
 * atlas (later phase), this becomes the single home for noise utilities.
 */

export function hash2(ix: number, iy: number, seed: number): number {
  let n = (((ix * 1619) ^ (iy * 31337)) + seed * 6271) | 0;
  n = ((n << 13) ^ n) | 0;
  return (((n * ((n * n * 15731 + 789221) | 0) + 1376312589) | 0) & 0x7fffffff) / 2147483648.0;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

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
 * frequencies and decreasing amplitudes. Returns ~[0, 1].
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
