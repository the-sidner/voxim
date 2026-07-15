/**
 * Body-recipe voxelizer (T-186 Layer 2) — fills each body part's volume from
 * the skeleton's resolved morph values instead of authored voxel positions.
 *
 * Single source of truth: `resolveBodyPartDims()` turns a `BodyPartRecipeDef`
 * + resolved morphParams into concrete (length, radiusTop, radiusBot) numbers.
 * Both consumers build on exactly this:
 *   - `evaluateBodyRecipe()` — voxelizes each part into `VoxelAtom[]`, keyed by
 *     boneId, for `upgradeToSkeletonModel` (client mesh build).
 *   - `bodyPartCapsule()` — turns the same resolved dims into a bone-local
 *     capsule for `hitbox_derive.ts`'s skeletal-capsule fallback (server +
 *     client hitbox derivation). Visuals and collision can't drift apart
 *     because both read this one function's output.
 *
 * Determinism: pure function of (recipe, morphParams) — no PRNG, no seed. The
 * morphParams themselves already came from the shared, seeded
 * `resolveMorphParams()` (store.ts) — same input, same output, every build,
 * both sides.
 *
 * Parts are authored along local +Z (the bone axis), centered on the bone
 * origin — the same convention `bone_segment.json` used, so a recipe part
 * slots into the exact same per-bone Group the sub-objects it replaces did.
 */
import type { BodyPartRecipeDef, BodyRecipeDef, SkeletonDef } from "./types.ts";
import type { VoxelAtom } from "./voxel.ts";
import { parseFormula, evalFormula, checkVars, type FormulaScope } from "./formula.ts";

/** Resolve a numeric-or-formula recipe field against the morph scope. */
function resolveField(v: number | string, scope: FormulaScope): number {
  return typeof v === "number" ? v : evalFormula(parseFormula(v), scope);
}

export interface ResolvedBodyPartDims {
  length: number;
  radiusTop: number;
  radiusBot: number; // == radiusTop for capsule
}

/** Resolve a part's concrete dimensions against a morph scope. Pure. */
export function resolveBodyPartDims(
  part: BodyPartRecipeDef,
  scope: FormulaScope,
): ResolvedBodyPartDims {
  const length = resolveField(part.length, scope);
  const radiusTop = resolveField(part.radiusOrWidthTop, scope);
  const radiusBot = part.shape === "tapered_box" && part.radiusOrWidthBot !== undefined
    ? resolveField(part.radiusOrWidthBot, scope)
    : radiusTop;
  return { length, radiusTop, radiusBot };
}

/**
 * Voxelize every recipe part into MODEL-space VoxelAtom[], keyed by boneId.
 * `resolveMaterial` mirrors the ProcModel GeneratorContext shape (name -> id)
 * so the same callback works for the client's `content.materials.get(name)`
 * and the server's identical registry.
 */
export function evaluateBodyRecipe(
  recipe: BodyRecipeDef,
  morphParams: Readonly<Record<string, number>>,
  resolveMaterial: (name: string) => number,
): Map<string, VoxelAtom[]> {
  const out = new Map<string, VoxelAtom[]>();
  for (const part of recipe.parts) {
    const dims = resolveBodyPartDims(part, morphParams);
    const materialId = resolveMaterial(part.material);
    const atoms = voxelizePart(part.shape, dims, recipe.voxelSize, materialId);
    if (atoms.length === 0) continue;
    const existing = out.get(part.boneId);
    if (existing) existing.push(...atoms);
    else out.set(part.boneId, atoms);
  }
  return out;
}

/**
 * Fill one part's volume with voxels of edge `voxelSize`, centered on the
 * bone origin, extending along local +Z for `dims.length`. Plain geometric
 * primitives only (capsule / tapered box) — no organic surface noise. That
 * belongs to the future humanoid_grammar substrate (T-301/T-302); this
 * recipe is strictly a subset it can build on top of.
 */
function voxelizePart(
  shape: BodyPartRecipeDef["shape"],
  dims: ResolvedBodyPartDims,
  voxelSize: number,
  materialId: number,
): VoxelAtom[] {
  const { length, radiusTop, radiusBot } = dims;
  if (length <= 0 || (radiusTop <= 0 && radiusBot <= 0)) return [];

  const atoms: VoxelAtom[] = [];
  const maxR = Math.max(radiusTop, radiusBot);
  const half = voxelSize / 2;
  // Voxel-center grid: cells at (i + 0.5) * voxelSize - maxR, sampled while
  // the cell center falls within the part's plan extent, so the fill is
  // symmetric about the bone's local X/Y axis regardless of voxelSize.
  const nRadial = Math.max(1, Math.ceil((maxR * 2) / voxelSize));
  const nLen = Math.max(1, Math.ceil(length / voxelSize));

  for (let iz = 0; iz < nLen; iz++) {
    const cz = (iz + 0.5) * voxelSize;
    const t = length > 0 ? cz / length : 0; // 0 at bone origin, 1 at far end
    const rAtZ = shape === "tapered_box"
      ? radiusTop + (radiusBot - radiusTop) * t
      : capsuleRadiusAt(t, length, radiusTop);
    if (rAtZ <= 0) continue;
    for (let ix = 0; ix < nRadial; ix++) {
      const cx = (ix + 0.5) * voxelSize - maxR;
      for (let iy = 0; iy < nRadial; iy++) {
        const cy = (iy + 0.5) * voxelSize - maxR;
        if (shape === "capsule") {
          if (cx * cx + cy * cy > rAtZ * rAtZ) continue;
        } else {
          if (Math.abs(cx) - half > rAtZ || Math.abs(cy) - half > rAtZ) continue;
        }
        atoms.push({ cx, cy, cz, sx: voxelSize, sy: voxelSize, sz: voxelSize, materialId });
      }
    }
  }
  return atoms;
}

/**
 * Capsule cross-section radius at normalised length t in [0,1]: a cylinder
 * of `radius` with hemispherical caps of the same radius, so the part is
 * watertight and rounded at both ends (no flat joint discs at bone seams).
 * Cap length is clamped to half the part's length for short/stubby parts
 * (hands, feet) so the hemispheres don't overlap past the midpoint.
 */
function capsuleRadiusAt(t: number, length: number, radius: number): number {
  const capLen = Math.min(radius, length / 2);
  if (capLen <= 0) return radius;
  const z = t * length;
  if (z < capLen) {
    const d = capLen - z;
    return Math.sqrt(Math.max(0, radius * radius - d * d));
  }
  if (z > length - capLen) {
    const d = z - (length - capLen);
    return Math.sqrt(Math.max(0, radius * radius - d * d));
  }
  return radius;
}

/**
 * Bone-local capsule endpoints + radius for a resolved part, in the SAME
 * entity-local convention `bone_segment.json` sub-objects used (local +Z is
 * the bone axis) — consumed by `hitbox_derive.ts`'s skeletal-capsule path so
 * collision reads the identical dimensions the mesh voxelizer just filled.
 */
export interface BodyPartCapsule {
  /** Entity-local, bone-relative. */
  fromX: number; fromY: number; fromZ: number;
  toX: number; toY: number; toZ: number;
  radius: number;
}

export function bodyPartCapsule(
  part: BodyPartRecipeDef,
  scope: FormulaScope,
): BodyPartCapsule {
  const dims = resolveBodyPartDims(part, scope);
  const halfWidth = Math.max(dims.radiusTop, dims.radiusBot);
  // T-323: `tapered_box` voxelizes a SQUARE cross-section of half-width
  // `halfWidth` (see voxelizePart's `Math.abs(cx)/cy) - half > rAtZ` box
  // test) — its corners sit at halfWidth*sqrt(2) from the bone axis, outside
  // an inscribed capsule of radius halfWidth. Circumscribe instead of
  // inscribe so the capsule covers the drawn box's corners (generous, not
  // exact — right call for combat feel per T-323). `capsule` shapes are
  // already round, so they need no adjustment.
  const radius = part.shape === "tapered_box" ? halfWidth * Math.SQRT2 : halfWidth;
  return { fromX: 0, fromY: 0, fromZ: 0, toX: 0, toY: 0, toZ: dims.length, radius };
}

/**
 * Boot cross-check (mirrors server.ts's fail-fast content checks): every
 * part's boneId must exist on the skeleton, and every formula field's
 * variables must resolve against the skeleton's declared morphParams ids.
 * Sampled at both morph extremes (not just neutral) so an expression that
 * goes negative or zero only at an extreme is caught at boot, not in play.
 * Throws on the first violation (fail-fast, matches every other content
 * cross-check in this codebase).
 */
export function crossCheckBodyRecipe(skeleton: SkeletonDef): void {
  const recipe = skeleton.bodyRecipe;
  if (!recipe) return;
  const boneIds = new Set(skeleton.bones.map((b) => b.id));
  const morphIds = new Set((skeleton.morphParams ?? []).map((p) => p.id));

  const minScope: Record<string, number> = {};
  const maxScope: Record<string, number> = {};
  for (const p of skeleton.morphParams ?? []) {
    minScope[p.id] = p.min;
    maxScope[p.id] = p.max;
  }

  for (const part of recipe.parts) {
    if (!boneIds.has(part.boneId)) {
      throw new Error(
        `[content] skeleton '${skeleton.id}' bodyRecipe part references unknown bone '${part.boneId}'. ` +
        `Known bones: [${[...boneIds].join(", ")}]`,
      );
    }
    const fields: Array<[string, number | string | undefined]> = [
      ["length", part.length],
      ["radiusOrWidthTop", part.radiusOrWidthTop],
      ["radiusOrWidthBot", part.radiusOrWidthBot],
    ];
    for (const [fieldName, v] of fields) {
      if (v === undefined || typeof v === "number") continue;
      const parsed = parseFormula(v);
      const missing = checkVars(parsed, morphIds);
      if (missing.size > 0) {
        throw new Error(
          `[content] skeleton '${skeleton.id}' bodyRecipe part '${part.boneId}' field '${fieldName}' ` +
          `formula '${v}' references unknown morph(s) [${[...missing].join(", ")}]. ` +
          `Known morphParams: [${[...morphIds].join(", ")}]`,
        );
      }
      for (const [label, scope] of [["min", minScope], ["max", maxScope]] as const) {
        const resolved = evalFormula(parsed, scope);
        if (!(resolved > 0)) {
          throw new Error(
            `[content] skeleton '${skeleton.id}' bodyRecipe part '${part.boneId}' field '${fieldName}' ` +
            `formula '${v}' resolves to ${resolved} at morph ${label} extremes — must be > 0.`,
          );
        }
      }
    }
  }
}
