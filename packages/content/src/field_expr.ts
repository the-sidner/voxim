/**
 * FieldExpr (T-311 grammar G2) — the shared, closed expression vocabulary over
 * the per-cell render fields (VegFieldGrid + SurfaceStateGrid planes). A scatter
 * density, a moss-blend amount, a wetness response — anything of the form
 * `look = f(canopyLight, corruption, fertility, wetness, …)` — is ONE summed-then-
 * clamped term list, mirroring `ResourceDef.rateModifier`. Pure + THREE-free; the
 * caller supplies a `sample(field) → 0..1` reader over the decoded grids. It is a
 * boot-validated field-name→value binding (NOT registry-dispatch — there is no
 * per-field behaviour to dispatch, only a name to resolve), kept a CLOSED
 * vocabulary so it never grows into a conditional tarpit.
 */

export type FieldCurve = "linear" | "smoothstep" | "step";

export interface FieldTerm {
  /** One of FIELD_NAMES — cross-checked at boot. */
  field: string;
  /** Remap shape applied to the normalised, min/max-windowed sample. */
  curve: FieldCurve;
  /** Input window: sample values ≤min → 0, ≥max → 1 before the curve.
   *  min > max INVERTS the ramp (≥min → 0, ≤max → 1) — the "denser in shade"
   *  authoring idiom (`min: 1.0, max: 0.15` on canopyLight). */
  min: number;
  max: number;
  /** Contribution scale; terms sum then clamp to [0,1]. */
  weight: number;
}

export type FieldExpr = readonly FieldTerm[];

/** The closed field vocabulary — the per-cell grid planes (T-311 P3 field-set). */
export const FIELD_NAMES = [
  "canopyLight", "corruption", "fertility",            // VegFieldGrid
  "wetness", "overgrowth", "wear",                     // SurfaceStateGrid
  "variantIndex", "ruinAge", "traffic",                //   …
  "surfaceLevel",                                      // WaterGrid
] as const;

const FIELD_SET: ReadonlySet<string> = new Set(FIELD_NAMES);

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function applyCurve(t: number, curve: FieldCurve): number {
  const c = clamp01(t);
  if (curve === "step") return c >= 0.5 ? 1 : 0;
  if (curve === "smoothstep") return c * c * (3 - 2 * c);
  return c; // linear
}

/**
 * Evaluate a FieldExpr to [0,1]. `sample(field)` returns the cell's field value
 * normalised to 0..1 (the caller divides the u8 plane by 255). Empty expr → 0.
 */
export function evaluateFieldExpr(expr: FieldExpr, sample: (field: string) => number): number {
  let sum = 0;
  for (const term of expr) {
    const raw = sample(term.field);
    const span = term.max - term.min;
    // |span|≈0 degenerates to a threshold at max. A NEGATIVE span (min > max) is
    // the inverted ramp — the plain (raw-min)/span already descends there, so it
    // must NOT fall into the degenerate branch (a `span <= 0` guard silently
    // turned every authored "denser in shade" window into raw≥max — T-311 P4).
    const t = Math.abs(span) <= 1e-6 ? (raw >= term.max ? 1 : 0) : (raw - term.min) / span;
    sum += term.weight * applyCurve(t, term.curve);
  }
  return clamp01(sum);
}

/**
 * Boot cross-check (fail-fast): every term's `field` is in the closed vocabulary.
 * `where` labels the owning content def for the error. Mirrors the
 * ResourceDef/Trigger boot checks.
 */
export function crossCheckFieldExpr(expr: FieldExpr, where: string): void {
  for (const term of expr) {
    if (!FIELD_SET.has(term.field)) {
      throw new Error(
        `[field_expr] ${where}: unknown field "${term.field}" ` +
        `(known: ${FIELD_NAMES.join(", ")})`,
      );
    }
    if (term.curve !== "linear" && term.curve !== "smoothstep" && term.curve !== "step") {
      throw new Error(`[field_expr] ${where}: field "${term.field}" has unknown curve "${term.curve}"`);
    }
  }
}
