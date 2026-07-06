/**
 * `blade_grammar` shared core (T-306) — the trace-relevant geometry evaluator
 * BOTH the client's registered ProcModel generator (visual voxels) and the
 * server's `weapon_trace` resolver (hit-sweep capsule) call, so a generated
 * weapon's blade shape and its hitbox can never drift apart. This is the
 * `humanoid_grammar`/`body_recipe.ts` pattern (T-302) applied to weapons: one
 * evaluator in `@voxim/content` (THREE-free, no server dependency), two
 * consumers.
 *
 * DESIGN_LANGUAGE.md §1 composition: LIMB spine (the blade's tapered length) +
 * SOLID pommel (a small load-bearing cap at the grip end) + SHELL guard (a
 * thin cross-piece separating grip from blade). Straight/curved/serrated are
 * the three authored `style`s — curved offsets the spine's midpoint
 * perpendicular to its axis; serrated notches the trailing edge with small
 * per-segment teeth. All three keep one straight-line trace capsule (the
 * *visual* spine bends; the *swept hitbox* — `deriveBladeGeometry`'s
 * `length`/`radius` — stays the same simple capsule every weapon already
 * uses, so this generator is a drop-in override of an authored `swingPath`'s
 * scalars, not a new collision primitive).
 *
 * Determinism: pure function of (seed, params) via the shared engine PRNG
 * (`makePrng` = `mulberry32`, re-exported from `store.ts`) — no `Math.random`,
 * no wall-clock, no ambient state. The same seed always yields the same
 * geometry on client and server.
 */
import type { VoxelAtom } from "./voxel.ts";
import { makePrng } from "./store.ts";

export type BladeStyle = "straight" | "curved" | "serrated";

export interface BladeGrammarParams {
  style: BladeStyle;
  /** [min,max] blade length, world units (LIMB spine). */
  lengthRange: [number, number];
  /** [min,max] swept-capsule radius, world units. */
  radiusRange: [number, number];
  /** [min,max] perpendicular curve offset at the spine midpoint, world units.
   *  Only read when `style === "curved"`; ignored otherwise. */
  curveRange?: [number, number];
  /** Voxel grain (world units) the spine/pommel/guard are built from. */
  voxelSize: number;
  /** SOLID pommel: length along the grip end, as a fraction of blade length. */
  pommelLengthFrac: number;
  /** SHELL guard: half-width (perpendicular to the spine) at the blade/grip
   *  seam, world units — DESIGN_LANGUAGE.md §4 "metal — very low as scatter,
   *  crafted" reads through here as a THIN cross-piece, not a bulk mass. */
  guardHalfWidth: number;
  /** Material NAMEs (resolved via ctx.resolveMaterial / a passed-in resolver). */
  materials: {
    blade: string;
    guard: string;
    pommel: string;
  };
}

/**
 * The trace-relevant subset — exactly what `weapon_trace` needs to override
 * an authored `WeaponActionDef.swingPath`'s `length`/`radius` scalars, and
 * what the visual generator builds its spine from. Curve offset is carried
 * too (not consumed by the capsule sweep — see the file doc — but exposed so
 * a caller can verify style-appropriate output, e.g. in tests).
 */
export interface BladeGeometry {
  length: number;
  radius: number;
  curveOffset: number;
}

/**
 * Pure geometry derivation — seed → concrete blade dimensions. Called first
 * by `bladeGrammarAtoms` (so the voxel emission always matches) and directly
 * by the server (which never touches VoxelAtom/materials).
 */
export function deriveBladeGeometry(seed: number, params: BladeGrammarParams): BladeGeometry {
  const rng = makePrng(seed);
  const [lmin, lmax] = params.lengthRange;
  const [rmin, rmax] = params.radiusRange;
  const length = lmin + rng() * (lmax - lmin);
  const radius = rmin + rng() * (rmax - rmin);
  let curveOffset = 0;
  if (params.style === "curved") {
    const [cmin, cmax] = params.curveRange ?? [0, 0];
    curveOffset = cmin + rng() * (cmax - cmin);
  }
  // Serrated consumes one more rng draw (tooth-depth jitter, applied per-tooth
  // in bladeGrammarAtoms) so every style advances the SAME number of draws
  // relative to its own branch — irrelevant here since curveOffset is the
  // last geometry scalar, but keeps the rng stream shape documented/stable
  // for anyone adding a fourth style later.
  return { length, radius, curveOffset };
}

/**
 * Emit the blade's `VoxelAtom[]`: LIMB spine (tapered box stack along local
 * +Y, matching the weapon model convention `model_sword_basic.json` used) +
 * SOLID pommel at the grip end + SHELL guard at the blade/grip seam.
 * Model space: x=right (blade width), y=forward (blade axis — the model's
 * existing sword convention), z=up (blade thickness).
 */
export function bladeGrammarAtoms(
  seed: number,
  params: BladeGrammarParams,
  resolveMaterial: (name: string) => number,
): VoxelAtom[] {
  const geo = deriveBladeGeometry(seed, params);
  const rng = makePrng(seed ^ 0x5a5a5a5a); // independent stream from per-tooth/style jitter, decorrelated from the geometry draws above
  const bladeMat = resolveMaterial(params.materials.blade);
  const guardMat = resolveMaterial(params.materials.guard);
  const pommelMat = resolveMaterial(params.materials.pommel);
  const vs = params.voxelSize;
  const atoms: VoxelAtom[] = [];

  const pommelLen = Math.max(vs, geo.length * params.pommelLengthFrac);
  const guardY = 0; // blade/grip seam sits at model-space y=0; pommel extends -y, blade extends +y
  const bladeHalfWidth = Math.max(vs / 2, geo.radius * 1.5);

  // ---- SOLID pommel — a small cap at the grip end (-y), tapering slightly
  // toward the butt so it reads as load-bearing bulk, not a floating box. ----
  const pommelSteps = Math.max(1, Math.round(pommelLen / vs));
  for (let i = 0; i < pommelSteps; i++) {
    const cy = guardY - (i + 0.5) * vs;
    const t = i / pommelSteps; // 0 at guard, 1 at butt
    const w = bladeHalfWidth * (1 - 0.3 * t);
    atoms.push({ cx: 0, cy, cz: 0, sx: w * 2, sy: vs, sz: w * 2, materialId: pommelMat });
  }

  // ---- SHELL guard — a thin cross-piece at the seam, wider than the blade
  // and the pommel so it reads as a separate covering layer (DESIGN_LANGUAGE
  // §1 SHELL: "reads as separate from what it covers"). ----
  const guardHalf = Math.max(bladeHalfWidth * 1.4, params.guardHalfWidth);
  atoms.push({ cx: 0, cy: guardY, cz: 0, sx: guardHalf * 2, sy: vs, sz: vs * 0.6, materialId: guardMat });

  // ---- LIMB spine — the blade proper, tapering toward the tip, extending
  // +y from the guard. `curved` bows the spine's x-offset via a sine profile
  // peaking at curveOffset; `serrated` notches alternating -x teeth along
  // the trailing edge. Both keep the SAME tip-length/radius the capsule
  // sweep uses — only the visual spine's per-step placement varies. ----
  const spineSteps = Math.max(1, Math.round(geo.length / vs));
  for (let i = 0; i < spineSteps; i++) {
    const t = (i + 0.5) / spineSteps; // 0 at guard, 1 at tip
    const cy = guardY + (i + 0.5) * vs;
    const taperW = bladeHalfWidth * (1 - 0.6 * t); // tapers toward the tip
    let cx = 0;
    if (params.style === "curved") {
      cx = Math.sin(t * Math.PI) * geo.curveOffset;
    }
    atoms.push({ cx, cy, cz: 0, sx: taperW * 2, sy: vs, sz: vs * 0.5, materialId: bladeMat });
    if (params.style === "serrated" && i % 2 === 0 && i < spineSteps - 1) {
      const toothDepth = taperW * (0.3 + rng() * 0.3);
      atoms.push({
        cx: cx - taperW - toothDepth * 0.5, cy, cz: 0,
        sx: toothDepth, sy: vs * 0.6, sz: vs * 0.35,
        materialId: bladeMat,
      });
    }
  }

  return atoms;
}
