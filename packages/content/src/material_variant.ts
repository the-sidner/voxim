/**
 * Material STATE-LADDER resolution (T-311 Phase 2, grammar G3). Applies a
 * `MaterialVariant` to a base `MaterialDef`, producing the effective def the
 * renderer bakes. ONE ladder models both two-state (sacred↔corrupted) and N-state
 * decay (fresh→weathered→decayed). THREE-free (content stays renderer-agnostic);
 * used by the Studio Material preview now and by the per-cell consumer once the
 * server SurfaceStateGrid.variantIndex lands (Phase 3).
 *
 * Selection is by a STABLE string id (invariant I3c) — `materialVariantIndex`
 * maps an authored id to its array position so reordering the JSON can't silently
 * remap cells; the per-cell grid will store that resolved index.
 */
import type { MaterialDef } from "./types.ts";

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function rgbToHsl(c: number): [number, number, number] {
  const r = ((c >> 16) & 0xff) / 255, g = ((c >> 8) & 0xff) / 255, b = (c & 0xff) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): number {
  h = ((h % 1) + 1) % 1;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const to = (x: number): number => Math.round(clamp01(x) * 255);
  return (to(f(0)) << 16) | (to(f(8)) << 8) | to(f(4));
}

/** Apply an additive HSL shift to a packed-RGB colour (hue wraps; sat/lum clamp). */
function applyHslShift(color: number, shift?: { h: number; s: number; l: number }): number {
  if (!shift) return color;
  const [h, s, l] = rgbToHsl(color);
  return hslToRgb(h + shift.h, clamp01(s + shift.s), clamp01(l + shift.l));
}

/** Array index of the variant with `id`, or -1 if the material has no such variant. */
export function materialVariantIndex(def: MaterialDef, id: string): number {
  return def.variants ? def.variants.findIndex((v) => v.id === id) : -1;
}

/**
 * The effective MaterialDef for `def` under variant `index`. Out-of-range or no
 * variants → the base def unchanged. colorOverride wins over colorShift;
 * emissiveCracks overrides emissive; addsTags append (server stat-derivation must
 * decide whether to honour them — the renderer ignores tags).
 */
export function resolveMaterialVariant(def: MaterialDef, index: number): MaterialDef {
  const variant = def.variants?.[index];
  if (!variant) return def;
  const color = variant.colorOverride ?? applyHslShift(def.color, variant.colorShift);
  const emissive = variant.emissiveCracks ?? def.emissive;
  const tags = variant.addsTags && variant.addsTags.length
    ? [...(def.tags ?? []), ...variant.addsTags]
    : def.tags;
  return { ...def, color, emissive, tags };
}
