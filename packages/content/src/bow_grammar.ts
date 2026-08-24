/**
 * `bow_grammar` shared core (T-346 — T-306 composition) — the bow/crossbow
 * twin of `blade_grammar.ts`/`armor_grammar.ts`: one THREE-free geometry
 * evaluator in `@voxim/content`, consumed by the client's registered
 * ProcModel generator to bake voxels. Unlike `blade_grammar`, there is no
 * server trace consumer — a bow is PURELY VISUAL (DESIGN_LANGUAGE.md
 * composition-wise it's the closer analog to `armor_grammar`, not
 * `blade_grammar`): it carries no hit-sweep capsule of its own. Arrow/bolt
 * collision radius lives on the projectile's own `ProjectileActionConfig`,
 * entirely separate from anything this file emits.
 *
 * DESIGN_LANGUAGE.md §1 composition: two mirrored LIMB spines (the curved
 * bow limbs / horizontal crossbow prod) + a SOLID riser (bow grip) or stock
 * (crossbow) they mount to + a thin taut LIMB string spanning limb-tip to
 * limb-tip. `variant` is the one discriminator: rather than a second
 * grammar file, "bow" and "crossbow" are two placements of the SAME
 * limb/riser/string composition —
 *   - "bow": the riser IS the limb axis (both run model +z, the held-item
 *     axis every other generated weapon uses — matches `blade_grammar`'s
 *     spine convention). Limbs mount at the riser's own ends and curve
 *     sideways (model +x); the string is drawn back along model -y (toward
 *     the archer's face).
 *   - "crossbow": the stock still runs model +z (the SAME held-item axis),
 *     but the limbs (the horizontal "prod") are mounted PERPENDICULAR to
 *     it at the stock's front face and run along model x, curving forward
 *     along z; the string is drawn back along model -z (toward the
 *     trigger, the same axis the prod's own curve bulges along — a taut
 *     string always sits behind the curve it draws against). A small SOLID
 *     mechanism block near the stock's rear is the crossbow-only
 *     silhouette element that reads as "crossbow" rather than "sideways
 *     bow" at a glance.
 *
 * Determinism: pure function of (seed, params) via the shared engine PRNG
 * (`makePrng` = mulberry32, re-exported from `store.ts`) — no `Math.random`,
 * no wall-clock, no ambient state. Both limbs are mirrored draws of the
 * SAME scalars (one `deriveBowGeometry` call), so a generated bow's two
 * limbs are always symmetric by construction.
 */
import type { VoxelAtom } from "./voxel.ts";
import { makePrng } from "./store.ts";

export type BowVariant = "bow" | "crossbow";

export interface BowGrammarParams {
  variant: BowVariant;
  /** [min,max] length of ONE limb, mount to nock tip, world units. */
  limbLengthRange: [number, number];
  /** [min,max] limb half-width at the mount end (tapers toward the tip), world units. */
  limbHalfWidthRange: [number, number];
  /** [min,max] perpendicular curve (recurve bulge) offset at each limb's
   *  midpoint, world units — see the file doc for which axis this bulges
   *  along per variant. */
  curveRange: [number, number];
  /** Voxel grain (world units) the limbs/riser/string are built from. */
  voxelSize: number;
  /** SOLID riser (bow grip) / stock (crossbow) length, world units. For
   *  "bow" the riser is CENTERED on the limb mount point (limbs extend
   *  both ways from its ends); for "crossbow" the stock trails BEHIND the
   *  limb mount point (the prod sits at the stock's front face). */
  riserLength: number;
  /** SOLID riser/stock half-width, world units. */
  riserHalfWidth: number;
  /** How far back the string is drawn off the limb plane, world units. */
  stringOffset: number;
  materials: {
    /** LIMB spines (bow limbs / crossbow prod). */
    limb: string;
    /** SOLID riser/stock. */
    riser: string;
    /** LIMB string. */
    string: string;
    /** Crossbow-only SOLID mechanism block. Defaults to `riser` when a
     *  crossbow's content omits it — "bow" never reads this field. */
    mechanism?: string;
  };
}

/** The randomized scalars — one draw, mirrored onto both limbs so they are
 *  symmetric by construction (see the file doc). */
export interface BowGeometry {
  limbLength: number;
  limbHalfWidth: number;
  curveOffset: number;
}

/** Pure geometry derivation — seed → concrete limb dimensions, shared by
 *  both limbs of a single bow/crossbow instance. */
export function deriveBowGeometry(seed: number, params: BowGrammarParams): BowGeometry {
  const rng = makePrng(seed);
  const [lmin, lmax] = params.limbLengthRange;
  const [wmin, wmax] = params.limbHalfWidthRange;
  const [cmin, cmax] = params.curveRange;
  const limbLength = lmin + rng() * (lmax - lmin);
  const limbHalfWidth = wmin + rng() * (wmax - wmin);
  const curveOffset = cmin + rng() * (cmax - cmin);
  return { limbLength, limbHalfWidth, curveOffset };
}

/**
 * Emit the bow/crossbow's `VoxelAtom[]`: two mirrored LIMB spines + a SOLID
 * riser/stock + a LIMB string anchored to the resolved limb tips (+
 * crossbow-only SOLID mechanism block). Model space: x=right, y=forward,
 * z=up — same convention `blade_grammar.ts` uses, so a generated bow slots
 * into the exact same held-item anchor math (`syncHandSlot`'s AABB scan)
 * every other generated weapon already uses.
 */
export function bowGrammarAtoms(
  seed: number,
  params: BowGrammarParams,
  resolveMaterial: (name: string) => number,
): VoxelAtom[] {
  const geo = deriveBowGeometry(seed, params);
  const limbMat = resolveMaterial(params.materials.limb);
  const riserMat = resolveMaterial(params.materials.riser);
  const stringMat = resolveMaterial(params.materials.string);
  const mechMat = resolveMaterial(params.materials.mechanism ?? params.materials.riser);
  const vs = Math.max(0.01, params.voxelSize);
  const atoms: VoxelAtom[] = [];

  const isCrossbow = params.variant === "crossbow";
  const limbAxis: "x" | "z" = isCrossbow ? "x" : "z";
  const riserLen = Math.max(vs, params.riserLength);
  const riserHalf = Math.max(vs / 2, params.riserHalfWidth);
  // bow: limbs mount at the riser's own ends (the riser is centered on the
  // mount point, so each limb starts riserLen/2 out from it). crossbow: the
  // prod mounts flush with the stock's front face (mount offset 0).
  const mountOffset = isCrossbow ? 0 : riserLen / 2;

  /** Map (along-limb-axis, perpendicular-curve) -> the two horizontal atom
   *  coords (the third, y, is always 0 for limb/string atoms — flat plane,
   *  matching the authored bow/crossbow models this replaces). */
  function limbPos(along: number, curvePerp: number): { cx: number; cz: number } {
    return limbAxis === "z" ? { cx: curvePerp, cz: along } : { cx: along, cz: curvePerp };
  }

  // ---- LIMB: two mirrored curved spines, tapering toward the nock tip.
  // `sign` is the mount-relative direction; returns the resolved tip point
  // so the string anchors to it exactly (curvePerp is 0 at t=1 — the
  // sine-profile curve returns to the centerline at the very tip, a
  // recurve-style silhouette). ----
  function buildLimb(sign: 1 | -1): { cx: number; cy: number; cz: number } {
    const steps = Math.max(1, Math.round(geo.limbLength / vs));
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps; // 0 at the mount, 1 at the tip
      const along = sign * (mountOffset + (i + 0.5) * vs);
      const taperW = geo.limbHalfWidth * (1 - 0.55 * t); // narrows toward the nock
      const curvePerp = Math.sin(t * Math.PI) * geo.curveOffset; // bulges at the midpoint, 0 at both ends
      const p = limbPos(along, curvePerp);
      atoms.push({
        cx: p.cx, cy: 0, cz: p.cz,
        sx: limbAxis === "z" ? taperW * 2 : vs,
        sy: vs * 0.6,
        sz: limbAxis === "z" ? vs : taperW * 2,
        materialId: limbMat,
      });
    }
    const tip = limbPos(sign * (mountOffset + geo.limbLength), 0);
    return { cx: tip.cx, cy: 0, cz: tip.cz };
  }
  const tipA = buildLimb(1);
  const tipB = buildLimb(-1);

  // ---- SOLID riser/stock — always built along model +z (the held-item
  // axis), independent of limbAxis: a bow's riser continues the SAME axis
  // its limbs run along; a crossbow's stock runs PERPENDICULAR to its
  // horizontal prod the way a real stock does. ----
  {
    const steps = Math.max(1, Math.round(riserLen / vs));
    const startZ = isCrossbow ? -riserLen : -riserLen / 2;
    for (let i = 0; i < steps; i++) {
      const cz = startZ + (i + 0.5) * vs;
      atoms.push({ cx: 0, cy: 0, cz, sx: riserHalf * 2, sy: vs * 0.8, sz: vs, materialId: riserMat });
    }
  }

  // ---- crossbow-only mechanism block (SOLID) — a small trigger/lock
  // volume near the stock's rear; the extra silhouette element that reads
  // as "crossbow" rather than "sideways bow" at a glance. ----
  if (isCrossbow) {
    atoms.push({
      cx: 0, cy: -vs * 0.6, cz: -riserLen * 0.55,
      sx: riserHalf * 1.3, sy: vs, sz: riserHalf * 1.3,
      materialId: mechMat,
    });
  }

  // ---- LIMB string — a thin strand from tip to tip, pulled back off the
  // limb plane (see file doc for which axis per variant). Endpoints are
  // EXACTLY tipA/tipB + the pull offset (t=0 and t=1 below), so a caller
  // can verify string-to-limb anchoring directly against buildLimb's own
  // returned tip points. ----
  {
    const pull = isCrossbow
      ? { x: 0, y: 0, z: -params.stringOffset }
      : { x: 0, y: -params.stringOffset, z: 0 };
    const dx = tipB.cx - tipA.cx, dy = tipB.cy - tipA.cy, dz = tipB.cz - tipA.cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.max(1, Math.round(dist / vs));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      atoms.push({
        cx: tipA.cx + dx * t + pull.x,
        cy: tipA.cy + dy * t + pull.y,
        cz: tipA.cz + dz * t + pull.z,
        sx: vs * 0.2, sy: vs * 0.2, sz: vs * 0.2,
        materialId: stringMat,
      });
    }
  }

  return atoms;
}
