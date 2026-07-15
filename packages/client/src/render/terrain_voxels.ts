/**
 * Terrain → voxel atoms (T-283, Phase 3). Re-expresses a chunk's heightmap +
 * material grid as a flat list of `VoxelAtom`s — the SAME currency props and
 * entities bake through `bakeVoxels` — so "voxels ARE terrain edges" is literally
 * true and terrain shares the one palette + displacement pipeline.
 *
 * THREE-free (mirrors the voxel_bake kitchen split): pure data in, atoms out; the
 * renderer turns the buckets into THREE meshes via bakeVoxels + buildVoxelMaterial.
 *
 * Atomization — COLUMN BOX, one atom per cell:
 *   Each cell occupies the world square [offX+cx, offX+cx+1] × [offZ+cy, offZ+cy+1]
 *   (model x=east, y=south) with its top at model z = h. The atom is a box whose
 *   TOP face sits at h and whose BOTTOM reaches the lowest of the cell's four
 *   neighbours — so its side faces ARE the exposed cliff walls, baked as displaced
 *   voxel boxes. Where every neighbour is at least as high, nothing is exposed and
 *   the box floors to one HEIGHT_STEP (a thin surface slab, never a degenerate
 *   zero-height box). The heightmap stays the collision/authoring source — this is
 *   render-only, physics untouched.
 *
 * No-crack guarantee: every terrain atom of a given material bakes with that
 * material's resolved `dispMag` (its `render.relief.dispMag`, or the shared
 * `TERRAIN_DISP_MAG` default when absent — the per-voxel default is never
 * used), so two column boxes of different depth that share a cliff-edge
 * corner and the SAME resolved dispMag get the identical `vertexDisp` offset
 * and stay welded. The guarantee holds WITHIN one material's own atoms
 * (which always share the same resolved value) — a cliff-edge corner shared
 * by two materials with DIFFERENT resolved dispMag will show a visible seam;
 * no material JSON authors a per-material override today, so this is not yet
 * an observed case. The shared world-position lattice keeps terrain welded
 * to on-lattice placed/dug voxels too.
 */
import type { HeightmapData, MaterialGridData, CliffGridData } from "@voxim/codecs";
import type { VoxelAtom, FieldExpr, CliffErosionState } from "@voxim/content";
import { evaluateFieldExpr } from "@voxim/content";
import { HEIGHT_STEP } from "@voxim/world";
import { voxHash } from "./voxel_bake.ts";
import { getCliffVoxeliser, type CliffBuildContext } from "./cliff_voxeliser.ts";

const CHUNK = 32;

/**
 * Default per-corner displacement magnitude for terrain atoms when a material
 * doesn't author `render.relief.dispMag` — % of the height quantum. Pinned
 * (not the per-voxel `0.10 * min(size)`) so variable-depth column boxes of
 * the SAME resolved dispMag don't crack at shared corners. Passed to
 * `bakeVoxels(atoms, mat, mag)`. Raised (was 0.10) to soften the strict grid
 * into a gently eroded forest floor while keeping the voxel read (T-310
 * level pass).
 */
export const TERRAIN_DISP_MAG = 0.18 * HEIGHT_STEP;

// ---- Named response constants for the disturbance/tint/roughness grammar.
// These are universal shape constants of the formula (same curve for every
// material) — per-material variation lives in warp/surfaceWarp/
// disturbanceField/dispMag, not here, so these stay local consts rather
// than promoting onto render.relief.
const MOTTLE_FLOOR = 0.25;         // tintScale floor at full disturbance recede
const OVERLAP_MARGIN = 0.05;       // oversize-into-known-solid safety margin
const SURFACE_ROUGH_MIN = 0.02;    // surfAmp threshold below which a slab stays flat
// Per-side exposure geometry for a cliff cell's warp jitter direction — NOT
// the cliff TRIGGER (that's the server's CliffGrid.edge flag now); this is
// local "which faces of the stack are outward vs welded" geometry, same
// threshold the retired EXPOSE_MIN heuristic used.
const CLIFF_SIDE_EXPOSE_MIN = 0.5;

// ---- Stacked-voxel cliff edges (T-311 P6 — server-authoritative CliffGrid
// retires the T-311 P4 client-heuristic trigger). A cliff cell is voxelised
// as a STACK of full-footprint stone-height boxes from the cliff base to the
// lip, dispatched through the `cliffVoxeliser` registry keyed by the cell's
// `CliffGrid.profileId` (resolved to a `CliffProfileDef.id` string via the
// client's stable alphabetical id→index table — see cliff_voxeliser.ts). NO
// inset geometry — the hand-stacked read comes entirely from the per-voxel
// language: exposed-face warp, per-voxel tint, corner displacement, and the
// Sobel outline inking each stone individually. Real geometry derived
// deterministically from the heightmap; collision stays the heightmap
// (barrier), so the two-tier gating (stairs) is untouched. The TRIGGER used
// to be a client-side depth heuristic (CLIFF_MIN/STONE_H/STACK_MAX/
// EXPOSE_MIN, retired this phase) — now it's the server's CliffGrid.edge
// flag; the stacked-stone LANGUAGE (warp/tint/displacement) survives on the
// atoms, now parameterized by the resolved CliffProfileDef instead of fixed
// constants.

/** The four cardinal neighbour chunks' heightmaps (null when not yet streamed). */
export interface ChunkNeighbours {
  N?: HeightmapData | null;
  E?: HeightmapData | null;
  S?: HeightmapData | null;
  W?: HeightmapData | null;
}

/**
 * Surface-field input (T-311 P4): the chunk's server-authoritative
 * SurfaceStateGrid planes + per-material response lookups resolved from
 * `MaterialDef.render` (undefined/false = material doesn't respond).
 * THREE-free and content-free — the renderer owns the content resolution;
 * this stage only derives each atom's G6 sidecar scalars: `moss01`
 * (overgrowth × floor/wall bias, terrace ledges boosted by joint) and
 * `wet01` (the raw wetness sample; the response lives in the material's
 * `wet_specular` treatment).
 */
export interface SurfaceFieldInput {
  /** SurfaceStateGrid.overgrowth, length CHUNK² (0..255). */
  overgrowth: Uint8Array;
  /** SurfaceStateGrid.wetness, length CHUNK² (0..255). */
  wetness: Uint8Array;
  mossBiasFor: (materialId: number) => { floor: number; wall: number; joint: number } | undefined;
  /** True when the material authors `render.wetness` → atoms carry `wet01`. */
  wets: (materialId: number) => boolean;
  /** Generic normalised field read (shared `sampleField` over the chunk's
   *  Veg/SurfaceState/Water grids) — evaluates `relief.disturbanceField`. */
  sample: (field: string, cellIdx: number) => number;
}

/**
 * Cliff-field input (T-311 P6): the chunk's server-authoritative CliffGrid
 * planes plus the resolved profile→erosion-state lookup. `profileOf` maps a
 * wire `profileId` (the stable alphabetical index, 0 = "none") to the
 * `CliffProfileDef.id` string the `cliffVoxeliser` registry dispatches on,
 * and the erosion state numbers for that profile at the cell's erosion
 * index (0=crisp/1=weathered/2=broken). Absent/all-zero `edge` planes fall
 * through to the flat/shallow single-column-box path unchanged.
 */
export interface CliffFieldInput {
  grid: CliffGridData;
  /** wire profileId → CliffProfileDef.id string (client's stable index table). */
  profileOf: (profileId: number) => string | undefined;
  /** CliffProfileDef.id + erosion index → the resolved erosion-state numbers. */
  erosionOf: (profileIdStr: string, erosionIdx: number) => CliffErosionState | undefined;
}

/**
 * Build one chunk's terrain atoms, bucketed by materialId (each bucket bakes into
 * one mesh). Neighbour heightmaps supply the column-floor depth for edge cells; a
 * missing neighbour falls back to "neighbour height = h" (no wall toward the
 * unloaded void — corrected to the true cliff when that chunk streams in).
 */
export function buildChunkAtoms(
  hm: HeightmapData,
  mats: MaterialGridData,
  nb: ChunkNeighbours,
  surface?: SurfaceFieldInput,
  /** Per-material relief response (`MaterialDef.render.relief`, T-311 P4):
   *  `warp` drives the cliff-stack stones, `surfaceWarp` the floor slabs, and
   *  `disturbanceField` is THE per-cell disturbance axis (1 = wild, 0 =
   *  civilized) scaling BOTH warps and the tint mottle — worked/trodden
   *  cells read orderly, wilderness rough and mottled. */
  reliefFor?: (materialId: number) => {
    dispMag?: number;
    warp?: number;
    surfaceWarp?: number;
    disturbanceField?: FieldExpr;
  } | undefined,
  cliff?: CliffFieldInput,
): Map<number, VoxelAtom[]> {
  const offX = hm.chunkX * CHUNK;
  const offZ = hm.chunkY * CHUNK; // model-space Y (south) offset — becomes three.js Z only via the coords.ts swap, NOT yet in three-space here.
  const H = (cx: number, cy: number): number => hm.data[cx + cy * CHUNK];

  // Neighbour height in one direction; for an edge cell read the adjacent chunk's
  // opposite edge, falling back to `h` (no wall) when that chunk is absent.
  const neigh = (cx: number, cy: number, dir: "N" | "E" | "S" | "W", h: number): number => {
    if (dir === "E") return cx < CHUNK - 1 ? H(cx + 1, cy) : (nb.E ? nb.E.data[0 + cy * CHUNK] : h);
    if (dir === "W") return cx > 0 ? H(cx - 1, cy) : (nb.W ? nb.W.data[(CHUNK - 1) + cy * CHUNK] : h);
    if (dir === "S") return cy < CHUNK - 1 ? H(cx, cy + 1) : (nb.S ? nb.S.data[cx + 0 * CHUNK] : h);
    /* N */ return cy > 0 ? H(cx, cy - 1) : (nb.N ? nb.N.data[cx + (CHUNK - 1) * CHUNK] : h);
  };

  const byMat = new Map<number, VoxelAtom[]>();
  for (let cy = 0; cy < CHUNK; cy++) {
    for (let cx = 0; cx < CHUNK; cx++) {
      const h = H(cx, cy);
      const m = mats.data[cx + cy * CHUNK];

      const hN = neigh(cx, cy, "N", h);
      const hE = neigh(cx, cy, "E", h);
      const hS = neigh(cx, cy, "S", h);
      const hW = neigh(cx, cy, "W", h);
      const hMinNbr = Math.min(hN, hE, hS, hW);
      // Exposed vertical extent below the top, floored to one step (flat plateau
      // cell → a thin slab whose underside hides beneath equal-height neighbours).
      const depth = Math.max(h - Math.min(h, hMinNbr), HEIGHT_STEP);

      let bucket = byMat.get(m);
      if (!bucket) byMat.set(m, bucket = []);

      // Surface fields (T-311 P4): this cell's overgrowth × the material's
      // authored moss bias, and the raw wetness sample for wetting materials;
      // non-responding materials skip entirely (atoms stay sidecar-free).
      const cellIdx = cx + cy * CHUNK;
      const mossBias = surface?.mossBiasFor(m);
      const og01 = mossBias ? surface!.overgrowth[cellIdx] / 255 : 0;
      const wet01 = surface?.wets(m) ? surface.wetness[cellIdx] / 255 : undefined;

      // Per-material relief response, hoisted above the cliff/slab split so
      // both branches read the SAME resolved disturbance/tint/dispMag —
      // welding within one material's own atoms only holds if every atom of
      // that material agrees on these values.
      const relief = reliefFor?.(m);
      // Disturbance axis: worked stone/ground near trodden paths reads
      // orderly; disturbanceField (0=civilized, 1=wild) scales every
      // disturbance channel below.
      const disturb = (relief?.disturbanceField && surface)
        ? evaluateFieldExpr(relief.disturbanceField, (f) => surface.sample(f, cellIdx))
        : 1;
      // Tint mottle recedes toward uniform on worked cells (a floor keeps
      // even laid stone faintly alive).
      const tintScale = relief?.disturbanceField ? MOTTLE_FLOOR + (1 - MOTTLE_FLOOR) * disturb : undefined;
      const dispMagBase = relief?.dispMag ?? TERRAIN_DISP_MAG;

      // ---- Stacked-voxel cliff (T-311 P6): the trigger is the SERVER's
      // CliffGrid.edge flag, not a client depth heuristic — "does the atlas
      // say this is a cliff-perimeter cell", replacing the retired
      // `depth > CLIFF_MIN` client trigger. profileId resolves to a
      // CliffProfileDef.id string via the client's stable index table;
      // dispatch through the registered voxeliser for that profile.
      const cliffEdge = cliff?.grid.edge[cellIdx] === 1;
      const profileIdStr = cliffEdge ? cliff!.profileOf(cliff!.grid.profileId[cellIdx]) : undefined;
      const voxeliser = profileIdStr ? getCliffVoxeliser(profileIdStr) : undefined;
      if (voxeliser) {
        const erosion = cliff!.erosionOf(profileIdStr!, cliff!.grid.erosion[cellIdx]);
        if (erosion) {
          const expE = (h - hE) > CLIFF_SIDE_EXPOSE_MIN;
          const expW = (h - hW) > CLIFF_SIDE_EXPOSE_MIN;
          const expS = (h - hS) > CLIFF_SIDE_EXPOSE_MIN;
          const expN = (h - hN) > CLIFF_SIDE_EXPOSE_MIN;
          const ctx: CliffBuildContext = {
            x0: offX + cx, y0: offZ + cy, h, depth,
            expE, expW, expS, expN,
            erosion, materialId: m, tintScale, dispMagBase,
            mossBias, og01, wet01,
          };
          for (const atom of voxeliser.build(ctx)) bucket.push(atom);
          continue;
        }
      }

      // Flat / shallow cell → one column box (top at h, floor at h-depth).
      // Surface roughness (T-311 P4): with `relief.surfaceWarp` the slab warps
      // its corners INDEPENDENTLY (own dispSeed) — rough, clod-like ground —
      // modulated 0..1 per cell by the optional `disturbanceField` FieldExpr
      // (e.g. traffic-inverted: wilderness rough, trodden paths smooth). The
      // slab OVERSIZES into known-solid (sideways into neighbour slabs, down
      // into the earth) so corner gaps only ever reveal another slab.
      const surfAmp = (relief?.surfaceWarp ?? 0) * disturb;
      const rough = surfAmp > SURFACE_ROUGH_MIN;
      const grow = rough ? surfAmp + OVERLAP_MARGIN : 0;
      bucket.push({
        cx: offX + cx + 0.5,
        cy: offZ + cy + 0.5,
        cz: h - depth / 2 - grow / 2,
        sx: 1 + 2 * grow,
        sy: 1 + 2 * grow,
        sz: depth + grow,
        materialId: m,
        ...(rough && {
          dispMag: dispMagBase + surfAmp,
          dispSeed: 1 + Math.floor(voxHash(offX + cx, offZ + cy, 0, 9) * 0xffff),
        }),
        ...(tintScale !== undefined && { tintScale }),
        ...(og01 > 0 && { moss01: og01 * mossBias!.floor }),
        ...(wet01 !== undefined && { wet01 }),
      });
    }
  }
  return byMat;
}
