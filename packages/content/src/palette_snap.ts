/**
 * Palette snap (T-280) — pulls an authored material color onto the nearest swatch
 * of the content palette ramp in CIELAB (perceptual) distance, so cohesion is
 * enforced by the load pipeline rather than by authoring discipline. THREE-free,
 * shared server↔client (runs in the content loader).
 */

/** Parse a `#rrggbb` (or `rrggbb`) string to a 0xRRGGBB number. */
export function hexStrToNum(s: string): number {
  return parseInt(s.replace("#", ""), 16) >>> 0;
}

function srgbToLinear(u8: number): number {
  const x = u8 / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** 0xRRGGBB → CIELAB (D65). */
function rgbToLab(color: number): [number, number, number] {
  const r = srgbToLinear((color >> 16) & 0xff);
  const g = srgbToLinear((color >> 8) & 0xff);
  const b = srgbToLinear(color & 0xff);
  // linear sRGB → XYZ (D65)
  const x = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / 0.95047);
  const fy = f(y / 1.0);
  const fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Squared CIELAB (ΔE) distance between two 0xRRGGBB colors. */
function labDist2(a: number, b: number): number {
  const la = rgbToLab(a);
  const lb = rgbToLab(b);
  return (la[0] - lb[0]) ** 2 + (la[1] - lb[1]) ** 2 + (la[2] - lb[2]) ** 2;
}

/**
 * Return the ramp swatch nearest to `color` in CIELAB. `ramp` is the list of
 * swatch colors as 0xRRGGBB numbers. Returns `color` unchanged if the ramp is
 * empty.
 */
export function snapColorToRamp(color: number, ramp: readonly number[]): number {
  if (ramp.length === 0) return color;
  let best = ramp[0];
  let bestD = Infinity;
  for (const swatch of ramp) {
    const d = labDist2(color, swatch);
    if (d < bestD) {
      bestD = d;
      best = swatch;
    }
  }
  return best;
}
