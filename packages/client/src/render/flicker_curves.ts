/**
 * Flicker-curve registry (T-311 Phase 2) — registry-dispatch over a content
 * `LightDef.flickerCurveId`, replacing the hardcoded oscillator that used to live
 * in light_manager.ts. A curve maps (t, phase, baseIntensity) → intensity. One
 * `registerFlickerCurve()` call per curve, cross-checked at client boot
 * (`crossCheckFlickerCurves`) — the same doctrine as the procmodel / texture-style
 * registries. Adding a flicker behaviour is a handler + a register() call.
 */
import type { ContentService } from "@voxim/content";

export type FlickerCurve = (t: number, phase: number, baseIntensity: number) => number;

const CURVES = new Map<string, FlickerCurve>();

export function registerFlickerCurve(id: string, fn: FlickerCurve): void {
  if (CURVES.has(id)) throw new Error(`flicker_curves: curve "${id}" already registered`);
  CURVES.set(id, fn);
}

export function getFlickerCurve(id: string): FlickerCurve | undefined {
  return CURVES.get(id);
}

export function flickerCurveIds(): string[] {
  return [...CURVES.keys()];
}

let _registered = false;

/** Register every built-in flicker curve. Idempotent. */
export function registerBuiltinFlickerCurves(): void {
  if (_registered) return;
  _registered = true;
  // No flicker — used by steady lights (lanterns set high, glowstone, etc).
  registerFlickerCurve("steady", (_t, _phase, base) => base);
  // The pre-T-311 two-sinusoid torch flicker (was light_manager.ts:86-88), with
  // the old ~0.3 amplitude × 0.4 gain folded into a fixed 0.12 swing.
  registerFlickerCurve("torch", (t, phase, base) => {
    const noise = 0.5 * (Math.sin(t * 4.1 + phase) + Math.sin(t * 7.3 + phase * 1.7));
    return base * Math.max(0.1, 1 + noise * 0.12);
  });
  // Gentler, slower hearth/candle sway.
  registerFlickerCurve("candle", (t, phase, base) => {
    const noise = 0.5 * (Math.sin(t * 2.0 + phase) + Math.sin(t * 3.3 + phase * 1.3));
    return base * Math.max(0.2, 1 + noise * 0.06);
  });
}

/**
 * Client boot cross-check (T-311): every `LightDef.flickerCurveId` resolves to a
 * registered curve. Throws on a typo — mirrors `crossCheckProcModels` /
 * `crossCheckTextureStyles`.
 */
export function crossCheckFlickerCurves(content: ContentService): void {
  registerBuiltinFlickerCurves();
  for (const l of content.lights.values()) {
    if (l.flickerCurveId && !CURVES.has(l.flickerCurveId)) {
      throw new Error(
        `[flicker_curves] light "${l.id}" names unknown flickerCurveId "${l.flickerCurveId}" ` +
        `(registered: ${flickerCurveIds().join(", ") || "none"})`,
      );
    }
  }
}
