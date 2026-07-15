/**
 * `armor_grammar` shared core (T-306) — SHELL plates keyed by bone, the
 * armor twin of `blade_grammar.ts`. Purely visual (armor has no hitbox of its
 * own — `armorReduction` is a DerivedItemStats scalar, not geometry), so
 * unlike blade_grammar there is no server trace consumer; this still lives
 * in `@voxim/content` (not the client package) because it follows the exact
 * same "one evaluator, THREE-free" shape as `body_recipe.ts` /
 * `blade_grammar.ts`, and because a future server-side consumer (e.g. a
 * coverage-based armor stat) would want the identical per-bone plate
 * dimensions without re-deriving them.
 *
 * DESIGN_LANGUAGE.md §1: a plate is SHELL — "a thin covering layer over a
 * SOLID/LIMB" — so each plate is a shallow shell offset OUTWARD from the
 * bone's body-recipe capsule radius, never a bulk replacement of the limb
 * underneath. §4: metal armor is "very low as scatter" (never ambient
 * clutter) but "medium as SHELL/SOLID surface relief" — plates are placed
 * deliberately per bone slot, one generator call per slot, not randomly
 * scattered across the body.
 *
 * Determinism: pure function of (seed, boneId, params) via the shared
 * engine PRNG (mulberry32) — same seed → same plate on client and any
 * future server consumer. `seed` is mixed with the bone id's own hash so
 * every plate on one armor piece (e.g. the four leg plates) still varies
 * independently instead of repeating one shape at every attachment point.
 */
import type { VoxelAtom } from "./voxel.ts";
import { makePrng } from "./store.ts";

export interface ArmorPlateSpec {
  /** Plate thickness, world units (SHELL — DESIGN_LANGUAGE.md §5's
   *  `thickness_range` hint, not a SOLID/LIMB bulk dimension). */
  thicknessRange: [number, number];
  /** Plate coverage as a fraction [0,1] of the underlying bone segment's
   *  length — 1 = full segment, <1 = a partial plate (pauldron vs greave). */
  coverageRange: [number, number];
  /** Half-width of the plate cross-section, world units. */
  halfWidth: number;
  /** Material NAME (resolved via ctx.resolveMaterial / a passed-in resolver). */
  material: string;
}

export interface ArmorGrammarParams {
  /** Voxel grain (world units) each plate is built from. */
  voxelSize: number;
  /** Per-bone plate spec, keyed by content boneId (e.g. "torso_upper",
   *  "head", "upper_leg_l") — the same ids `SkeletonDef.bones` and an armor
   *  prefab's `armor.coversBones` (T-223) use. A generator MAY author more
   *  bones here than any one item covers (e.g. one shared iron-plate
   *  generator authoring torso_upper/head/upper_leg_l/upper_leg_r for three
   *  different items); `coversBones` on the ITEM is what narrows which of
   *  these plates that piece actually renders. */
  plates: Record<string, ArmorPlateSpec>;
}

/** Deterministic string hash (FNV-1a) — mixes a boneId into the armor's own
 *  seed so every plate on one piece varies independently. Matches the
 *  hash32 shape already duplicated at several call sites in this codebase
 *  (tile-server spawner.ts, client scatter_renderer.ts) — kept local here
 *  rather than importing one of those (client/server package boundary). */
function hashBoneId(s: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Emit one bone-parented plate's `VoxelAtom[]`, bone-LOCAL space (the same
 * convention `bone_segment.json`/`body_recipe.ts` parts use: local +Z is the
 * bone axis, centered on the bone origin) — so the result slots into the
 * exact same per-bone Group `ensureBoneAttachment`/`attachArmorToSlot`
 * already parent armor anchors to. `segmentLength` is the underlying bone's
 * length (from `boneSegmentLength`/the body recipe's resolved dims) so the
 * plate's coverage fraction has a concrete extent to work against.
 *
 * Returns an empty array if `boneId` has no authored plate spec — callers
 * simply skip attaching anything for that slot (mirrors a missing armor
 * prefab: no plate, no error).
 */
export function armorGrammarAtoms(
  seed: number,
  boneId: string,
  segmentLength: number,
  params: ArmorGrammarParams,
  resolveMaterial: (name: string) => number,
): VoxelAtom[] {
  const spec = params.plates[boneId];
  if (!spec || segmentLength <= 0) return [];

  const plateSeed = seed ^ hashBoneId(boneId);
  const rng = makePrng(plateSeed);
  const matId = resolveMaterial(spec.material);

  const [tmin, tmax] = spec.thicknessRange;
  const thickness = tmin + rng() * (tmax - tmin);
  const [cmin, cmax] = spec.coverageRange;
  const coverage = Math.max(0, Math.min(1, cmin + rng() * (cmax - cmin)));
  const plateLength = segmentLength * coverage;
  if (plateLength <= 0) return [];

  const vs = Math.max(0.01, params.voxelSize);
  const steps = Math.max(1, Math.round(plateLength / vs));
  const startZ = (segmentLength - plateLength) / 2; // center the plate on the bone segment

  const atoms: VoxelAtom[] = [];
  for (let i = 0; i < steps; i++) {
    const cz = startZ + (i + 0.5) * vs;
    // Slight per-step width taper (95%→100%→95%) so a plate reads as a
    // rounded shell rather than a perfectly rectangular slab — organic
    // surface per DESIGN_LANGUAGE.md §2 ("organic everywhere").
    const t = steps > 1 ? i / (steps - 1) : 0.5;
    const taper = 1 - 0.05 * Math.sin(t * Math.PI * 2);
    atoms.push({
      cx: 0, cy: 0, cz,
      sx: spec.halfWidth * 2 * taper, sy: thickness, sz: vs,
      materialId: matId,
    });
  }
  return atoms;
}
