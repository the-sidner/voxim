/**
 * Client palette accessor (T-280) — the single render-side color source. The
 * renderer installs the bootstrap palette via `setClientPalette` when content
 * arrives; module render code reads named tokens through `paletteToken` /
 * `paletteColor` instead of hardcoding hex literals.
 *
 * `tokens` alias a render role (ghost, blueprint, gate, trail, …) to a ramp
 * swatch; `swatch` reads a ramp color by name directly. Fallbacks are benign
 * neutrals — every token site renders only after content (entities, ghosts,
 * gates all appear post-join), so a fallback should never actually show.
 */
import * as THREE from "three";
import type { Palette } from "@voxim/content";
import { hexStrToNum } from "@voxim/content";

let ramp: Record<string, number> = {};
let tokens: Record<string, string> = {};

/** Install the palette delivered in the bootstrap blob. */
export function setClientPalette(p: Palette): void {
  ramp = Object.fromEntries(Object.entries(p.ramp).map(([k, v]) => [k, hexStrToNum(v)]));
  tokens = p.tokens ?? {};
}

/** Ramp swatch color (0xRRGGBB) by name. Magenta if the name is unknown. */
export function paletteSwatch(name: string): number {
  return ramp[name] ?? 0xff00ff;
}

/** Render-token color (0xRRGGBB) — resolves token → swatch. */
export function paletteToken(name: string): number {
  const swatch = tokens[name];
  return swatch !== undefined ? paletteSwatch(swatch) : 0x808080;
}

/** Render-token as a fresh THREE.Color. */
export function paletteColor(name: string): THREE.Color {
  return new THREE.Color(paletteToken(name));
}
