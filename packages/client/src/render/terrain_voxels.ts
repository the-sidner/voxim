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
 * No-crack guarantee: every terrain atom bakes with the SAME constant
 * `TERRAIN_DISP_MAG` (not the per-voxel default), so two column boxes of different
 * depth that share a cliff-edge corner get the identical `vertexDisp` offset and
 * stay welded. The same constant + the shared world-position lattice keep terrain
 * welded to on-lattice placed/dug voxels too.
 */
import type { HeightmapData, MaterialGridData } from "@voxim/codecs";
import type { VoxelAtom, FieldExpr } from "@voxim/content";
import { evaluateFieldExpr } from "@voxim/content";
import { HEIGHT_STEP } from "@voxim/world";
import { voxHash } from "./voxel_bake.ts";

const CHUNK = 32;

/**
 * Constant per-corner displacement magnitude for ALL terrain atoms — % of the
 * height quantum. Pinned (not the per-voxel `0.10 * min(size)`) so variable-depth
 * column boxes don't crack at shared corners. Passed to `bakeVoxels(atoms, mat, mag)`.
 * Raised (was 0.10) to soften the strict grid into a gently eroded forest floor
 * while keeping the voxel read (T-310 level pass).
 */
export const TERRAIN_DISP_MAG = 0.18 * HEIGHT_STEP;

// ---- Stacked-voxel cliff edges (T-311 P4 — replaces the T-310 inset ziggurat).
// A cliff cell (a plateau edge or a forest/stone wall) is voxelised as a STACK
// of full-footprint stone-height boxes from the cliff base to the lip. NO inset
// geometry — the hand-stacked read comes entirely from the per-voxel language:
// exposed-face warp (`render.relief.warp`), per-voxel tint, corner displacement,
// and the Sobel outline inking each stone individually. This also removes the
// whole family of recede-degeneration bugs (a 1-wide ridge double-inset itself
// to negative width and vanished). Real geometry derived deterministically from
// the heightmap; collision stays the heightmap (barrier), so the two-tier
// gating (stairs) is untouched. NOTE: still the client-voxeliser stopgap; real
// cliff shape folds into the terrain DATA MODEL (server-authoritative stepped
// Heightmap) in T-311 Phase 6, which retires this trigger — the stacked-stone
// LANGUAGE (warp/tint/displacement) survives it, living on the atoms.
const CLIFF_MIN   = 1.2;   // expose depth (world units) above which we stack
const STONE_H     = 0.7;   // target stone height (stack quantum)
const STACK_MAX   = 5;     // cap boxes per cliff cell (perf bound; deeper → taller stones)
const EXPOSE_MIN  = 0.5;   // a side is "exposed" when its neighbour is this much lower

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
   *  Veg/SurfaceState/Water grids) — evaluates `relief.surfaceWarpField`. */
  sample: (field: string, cellIdx: number) => number;
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
   *  `warp` drives the cliff-stack stones (exposed-face jitter + independent
   *  corner warp + oversize-into-solid); `surfaceWarp`(+`surfaceWarpField`)
   *  drives the same decorrelated warp on walkable floor slabs — rough
   *  ground, modulated per cell by the server render fields. */
  reliefFor?: (materialId: number) => {
    warp?: number;
    surfaceWarp?: number;
    surfaceWarpField?: FieldExpr;
  } | undefined,
): Map<number, VoxelAtom[]> {
  const offX = hm.chunkX * CHUNK;
  const offZ = hm.chunkY * CHUNK;
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

      if (depth > CLIFF_MIN) {
        // ---- Stacked-voxel cliff: full-footprint stone boxes piled from the
        // base to the lip. Sub-lip stones jitter their EXPOSED faces by
        // ±warp/2 (deterministic voxHash off the face's world position + stone
        // top, so every stone differs but chunk rebuilds are identical); the
        // WELDED faces (toward equal/higher neighbours) never move — no slit
        // opens into the void under the adjacent plateau slab — and z is
        // untouched (stone courses stay contiguous; the walking surface at h
        // is the top stone's exact top face). The TOP stone stays fully exact:
        // it IS the plateau lip, and the collision edge lives there.
        const expE = (h - hE) > EXPOSE_MIN;
        const expW = (h - hW) > EXPOSE_MIN;
        const expS = (h - hS) > EXPOSE_MIN;
        const expN = (h - hN) > EXPOSE_MIN;
        const n = Math.min(STACK_MAX, Math.max(2, Math.round(depth / STONE_H)));
        const bh = depth / n;
        const warpAmp = reliefFor?.(m)?.warp ?? 0;
        // Course boundaries between stones, z-jittered ±warp/4 (per cell +
        // course, deterministic) so the horizontal seams run UNEVEN like real
        // coursework. Both stones at a seam share the jittered boundary —
        // courses stay contiguous; the lip (index 0) and the base stay exact.
        const zb: number[] = [h];
        for (let i = 1; i < n; i++) {
          const jitter = warpAmp > 0 ? (voxHash(offX + cx, offZ + cy, i, 7) - 0.5) * warpAmp * 0.5 : 0;
          zb.push(h - i * bh + jitter);
        }
        zb.push(h - depth);
        // Sub-lip stones displace their corners HARDER than the terrain
        // constant — a shared seam vertex then offsets differently per side,
        // opening deliberate chinks between stones (never on the lip).
        const stoneDisp = warpAmp > 0 ? TERRAIN_DISP_MAG + warpAmp * 0.3 : undefined;
        // Independently-warped stones open corner gaps; a gap must only ever
        // reveal ANOTHER stone, never the bright world behind the wall. So
        // every sub-lip stone is OVERSIZED into known-solid: up into the stone
        // above, down into the one below / the base, and sideways into the
        // hill on welded sides — clipping is deliberate and invisible. The
        // overlap exceeds the max corner roll (dispMag), so even a fully
        // rolled-back corner still sits inside the neighbouring stone.
        const overlap = stoneDisp !== undefined ? stoneDisp + 0.05 : 0;
        for (let i = 0; i < n; i++) {
          let zTop = zb[i], zBot = zb[i + 1];
          let x0 = offX + cx, x1 = offX + cx + 1;
          let y0 = offZ + cy, y1 = offZ + cy + 1;
          if (warpAmp > 0 && i > 0) {
            if (expE) x1 += (voxHash(x1, y0, zTop, 3) - 0.5) * warpAmp;
            if (expW) x0 += (voxHash(x0, y0, zTop, 4) - 0.5) * warpAmp;
            if (expS) y1 += (voxHash(x0, y1, zTop, 5) - 0.5) * warpAmp;
            if (expN) y0 += (voxHash(x0, y0, zTop, 6) - 0.5) * warpAmp;
            zTop += overlap;          // clip up into the stone above (lip stays exact)
            zBot -= overlap;          // clip down into the stone below / the base
            if (!expE) x1 += overlap; // clip into the hill on welded sides
            if (!expW) x0 -= overlap;
            if (!expS) y1 += overlap;
            if (!expN) y0 -= overlap;
          }
          bucket.push({
            cx: (x0 + x1) / 2,
            cy: (y0 + y1) / 2,
            cz: (zTop + zBot) / 2,
            sx: x1 - x0, sy: y1 - y0, sz: zTop - zBot,
            materialId: m,
            // Sub-lip stones warp their corners INDEPENDENTLY (own dispSeed):
            // each pokes out of the merged wall and clips into its neighbours
            // — per-stone facet normals then light every stone differently.
            // The lip stone stays welded to the plateau (walk surface).
            ...(i > 0 && stoneDisp !== undefined && {
              dispMag: stoneDisp,
              dispSeed: 1 + Math.floor(voxHash(offX + cx, offZ + cy, i, 8) * 0xffff),
            }),
            // The top stone reads as floor; the face stones below gather moss
            // in their seams (jointBoost) — "oldest stone most swallowed".
            ...(og01 > 0 && {
              moss01: i === 0
                ? og01 * mossBias!.floor
                : Math.min(1, og01 * mossBias!.wall * (1 + mossBias!.joint)),
            }),
            ...(wet01 !== undefined && { wet01 }),
          });
        }
        continue;
      }

      // Flat / shallow cell → one column box (top at h, floor at h-depth).
      // Surface roughness (T-311 P4): with `relief.surfaceWarp` the slab warps
      // its corners INDEPENDENTLY (own dispSeed) — rough, clod-like ground —
      // modulated 0..1 per cell by the optional `surfaceWarpField` FieldExpr
      // (e.g. traffic-inverted: wilderness rough, trodden paths smooth). The
      // slab OVERSIZES into known-solid (sideways into neighbour slabs, down
      // into the earth) so corner gaps only ever reveal another slab.
      const relief = reliefFor?.(m);
      let surfAmp = relief?.surfaceWarp ?? 0;
      if (surfAmp > 0 && relief?.surfaceWarpField && surface) {
        surfAmp *= evaluateFieldExpr(relief.surfaceWarpField, (f) => surface.sample(f, cellIdx));
      }
      const rough = surfAmp > 0.02;
      const grow = rough ? surfAmp + 0.05 : 0;
      bucket.push({
        cx: offX + cx + 0.5,
        cy: offZ + cy + 0.5,
        cz: h - depth / 2 - grow / 2,
        sx: 1 + 2 * grow,
        sy: 1 + 2 * grow,
        sz: depth + grow,
        materialId: m,
        ...(rough && {
          dispMag: TERRAIN_DISP_MAG + surfAmp,
          dispSeed: 1 + Math.floor(voxHash(offX + cx, offZ + cy, 0, 9) * 0xffff),
        }),
        ...(og01 > 0 && { moss01: og01 * mossBias!.floor }),
        ...(wet01 !== undefined && { wet01 }),
      });
    }
  }
  return byMat;
}
