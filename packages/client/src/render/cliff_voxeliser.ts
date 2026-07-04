/**
 * CliffVoxeliser registry (T-311 Phase 6) — replaces terrain_voxels.ts's
 * hardcoded CLIFF_MIN/STONE_H/STACK_MAX/EXPOSE_MIN stacking heuristic with
 * content-driven dispatch keyed by `CliffGrid.profileId` (resolved to a
 * `CliffProfileDef.id` string via the client's stable alphabetical
 * id→index table — the SAME order the atlas `cliffStage` builds, per I3c).
 * Mirrors `surface_treatments.ts`'s module-level Map + register + idempotent
 * builtin-registration + boot cross-check pattern exactly.
 *
 * THREE-free (mirrors terrain_voxels.ts's own purity contract): handlers
 * return `VoxelAtom[]`, no THREE imports. A handler receives exactly what
 * the retired inline stacking branch computed — depth, exposure flags,
 * warp/chink numbers resolved from the profile's erosion state, plus the
 * same disturbance/tint/moss/wetness inputs `buildChunkAtoms` already
 * threads through the flat/shallow path.
 */
import type { VoxelAtom, CliffProfileDef, CliffErosionState, ContentService } from "@voxim/content";
import { voxHash } from "./voxel_bake.ts";

/** Per-cell inputs a cliff voxeliser needs to build one cell's stone stack.
 *  Coordinates are MODEL space (x=east, y=south), matching terrain_voxels.ts. */
export interface CliffBuildContext {
  /** World-space cell origin (offX+cx, offZ+cy) and the cell's top height. */
  x0: number; y0: number; h: number;
  /** Exposed vertical extent below the top (floored to one HEIGHT_STEP). */
  depth: number;
  /** Which of the 4 sides are exposed (neighbour lower by more than EXPOSE_MIN). */
  expE: boolean; expW: boolean; expS: boolean; expN: boolean;
  /** Resolved erosion-state numbers for this profile. */
  erosion: CliffErosionState;
  materialId: number;
  /** Disturbance-scaled tint mottle (undefined = material doesn't use it). */
  tintScale?: number;
  /** Base corner-displacement magnitude (material's resolved dispMag or the
   *  terrain default) — stones displace this PLUS an erosion-scaled extra. */
  dispMagBase: number;
  /** Moss bias (floor/wall/joint) — undefined = material doesn't moss. */
  mossBias?: { floor: number; wall: number; joint: number };
  og01: number;
  wet01?: number;
}

export interface CliffVoxeliser {
  id: string;
  build(ctx: CliffBuildContext): VoxelAtom[];
}

const REGISTRY = new Map<string, CliffVoxeliser>();

export function registerCliffVoxeliser(id: string, voxeliser: CliffVoxeliser): void {
  REGISTRY.set(id, voxeliser);
}

export function cliffVoxeliserIds(): string[] {
  return [...REGISTRY.keys()];
}

export function getCliffVoxeliser(id: string): CliffVoxeliser | undefined {
  registerBuiltinCliffVoxelisers(); // lazy, idempotent (the TextureStyle idiom)
  return REGISTRY.get(id);
}

/**
 * Build the SAME stable alphabetical id→index table the atlas `cliffStage`
 * builds (index 0 reserved = "no cliff here"; profile ids start at 1) — I3c's
 * cross-check purpose depends on both sides constructing this identically.
 * Returns a lookup by wire index → `CliffProfileDef.id`.
 */
export function buildCliffProfileIndex(content: ContentService): ReadonlyArray<string> {
  const sorted = [...content.cliffProfiles.values()].sort((a, b) => a.id.localeCompare(b.id));
  return sorted.map((p) => p.id);
}

// ---- Named response constants (moved from terrain_voxels.ts's retired
// CLIFF_* trigger block — these are the shape constants of the stacking
// formula, unchanged; only the TRIGGER (depth > CLIFF_MIN) and the per-
// profile tierCount/jitterAmp/edgeChinkiness numbers are now content). ----
const COURSE_JITTER_SCALE = 0.5;   // cliff course-boundary z-jitter vs corner warp
const CHINK_DISP_SCALE = 0.3;      // sub-lip stone corner-disp extra vs jitterAmp
const OVERLAP_MARGIN = 0.05;       // oversize-into-known-solid safety margin

/**
 * `columnar` — the exact stacking algorithm the retired inline branch used
 * (moved verbatim, parameterized by the profile's erosion state instead of
 * the old STACK_MAX/STONE_H/CHINK_DISP_SCALE constants).
 */
function buildStack(ctx: CliffBuildContext, jitterAmpScale: number, chinkScale: number): VoxelAtom[] {
  const { x0, y0, h, depth, expE, expW, expS, expN, erosion, materialId, tintScale, dispMagBase, mossBias, og01, wet01 } = ctx;
  const out: VoxelAtom[] = [];
  const n = Math.max(1, erosion.tierCount);
  const bh = depth / n;
  const warpAmp = erosion.jitterAmp * jitterAmpScale;

  const zb: number[] = [h];
  for (let i = 1; i < n; i++) {
    const jitter = warpAmp > 0 ? (voxHash(x0, y0, i, 7) - 0.5) * warpAmp * COURSE_JITTER_SCALE : 0;
    zb.push(h - i * bh + jitter);
  }
  zb.push(h - depth);

  const stoneDisp = warpAmp > 0 ? dispMagBase + warpAmp * erosion.edgeChinkiness * chinkScale : undefined;
  const overlap = stoneDisp !== undefined ? stoneDisp + OVERLAP_MARGIN : 0;

  for (let i = 0; i < n; i++) {
    let zTop = zb[i], zBot = zb[i + 1];
    let x1 = x0 + 1, xa = x0;
    let y1 = y0 + 1, ya = y0;
    if (warpAmp > 0 && i > 0) {
      if (expE) x1 += (voxHash(x1, ya, zTop, 3) - 0.5) * warpAmp;
      if (expW) xa += (voxHash(xa, ya, zTop, 4) - 0.5) * warpAmp;
      if (expS) y1 += (voxHash(xa, y1, zTop, 5) - 0.5) * warpAmp;
      if (expN) ya += (voxHash(xa, ya, zTop, 6) - 0.5) * warpAmp;
      zTop += overlap;
      zBot -= overlap;
      if (!expE) x1 += overlap;
      if (!expW) xa -= overlap;
      if (!expS) y1 += overlap;
      if (!expN) ya -= overlap;
    }
    out.push({
      cx: (xa + x1) / 2,
      cy: (ya + y1) / 2,
      cz: (zTop + zBot) / 2,
      sx: x1 - xa, sy: y1 - ya, sz: zTop - zBot,
      materialId,
      ...(i > 0 && stoneDisp !== undefined && {
        dispMag: stoneDisp,
        dispSeed: 1 + Math.floor(voxHash(x0, y0, i, 8) * 0xffff),
      }),
      ...(tintScale !== undefined && { tintScale }),
      ...(og01 > 0 && mossBias && {
        moss01: i === 0
          ? og01 * mossBias.floor
          : Math.min(1, og01 * mossBias.wall * (1 + mossBias.joint)),
      }),
      ...(wet01 !== undefined && { wet01 }),
    });
  }
  return out;
}

const columnar: CliffVoxeliser = { id: "columnar", build: (ctx) => buildStack(ctx, 1, 1) };
/** `broken` — higher jitter/chinkiness read (the profile's own erosion-state
 *  numbers already carry most of this; the multiplier adds a per-profile
 *  identity on top so "broken" reads more jagged than "columnar" even at the
 *  same nominal erosion state). */
const broken: CliffVoxeliser = { id: "broken", build: (ctx) => buildStack(ctx, 1.3, 1.2) };
/** `sloped` — fewer, taller, less-warped courses (erosion.tierCount/jitterAmp
 *  already author this lower; the multiplier softens it further). */
const sloped: CliffVoxeliser = { id: "sloped", build: (ctx) => buildStack(ctx, 0.6, 0.7) };
/** `stone_stair` — the near-no-op used on stair-adjacent ramp cells: a thin
 *  single slab (matching a smooth ramp's look), never a stack. */
const stoneStair: CliffVoxeliser = {
  id: "stone_stair",
  build: (ctx) => {
    const { x0, y0, h, depth, materialId, tintScale, og01, mossBias, wet01 } = ctx;
    return [{
      cx: x0 + 0.5, cy: y0 + 0.5, cz: h - depth / 2,
      sx: 1, sy: 1, sz: depth,
      materialId,
      ...(tintScale !== undefined && { tintScale }),
      ...(og01 > 0 && mossBias && { moss01: og01 * mossBias.floor }),
      ...(wet01 !== undefined && { wet01 }),
    }];
  },
};

let _registered = false;

/** Register every built-in cliff voxeliser. Idempotent. */
export function registerBuiltinCliffVoxelisers(): void {
  if (_registered) return;
  _registered = true;
  registerCliffVoxeliser(columnar.id, columnar);
  registerCliffVoxeliser(broken.id, broken);
  registerCliffVoxeliser(sloped.id, sloped);
  registerCliffVoxeliser(stoneStair.id, stoneStair);
}

/**
 * Client boot cross-check (T-311 P6): every `CliffProfileDef.id` the
 * bootstrap blob carries resolves to a registered voxeliser. Throws on a
 * typo — mirrors `crossCheckTextureStyles` / `crossCheckFlickerCurves`.
 */
export function crossCheckCliffVoxelisers(content: ContentService): void {
  registerBuiltinCliffVoxelisers();
  for (const p of content.cliffProfiles.values()) {
    if (!REGISTRY.has(p.id)) {
      throw new Error(
        `[cliff_voxeliser] CliffProfileDef "${p.id}" has no registered voxeliser ` +
        `(registered: ${cliffVoxeliserIds().join(", ") || "none"})`,
      );
    }
  }
}
