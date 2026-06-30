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
import type { VoxelAtom } from "@voxim/content";
import { HEIGHT_STEP } from "@voxim/world";

const CHUNK = 32;

/**
 * Constant per-corner displacement magnitude for ALL terrain atoms — % of the
 * height quantum. Pinned (not the per-voxel `0.10 * min(size)`) so variable-depth
 * column boxes don't crack at shared corners. Passed to `bakeVoxels(atoms, mat, mag)`.
 * Raised (was 0.10) to soften the strict grid into a gently eroded forest floor
 * while keeping the voxel read (T-310 level pass).
 */
export const TERRAIN_DISP_MAG = 0.18 * HEIGHT_STEP;

// ---- Terraced cliff edges (T-310 — the upper/lower transition as terrain
// definition, not a shader hack). A cliff cell (a plateau edge or a forest/stone
// wall) is voxelised as a STACK of sub-boxes forming a bottom-wide ziggurat: the
// bottom box reaches the cliff lip and each higher box steps BACK from the drop,
// so the exposed face descends as a visible staircase of ledges. Real geometry
// derived deterministically from the heightmap; collision stays the heightmap
// (barrier), so the two-tier gating (stairs) is untouched. NOTE: this is the
// client-voxeliser stopgap; real terracing folds into the terrain DATA MODEL
// (server-authoritative stepped Heightmap) in T-311 Phase 6, which retires this.
const CLIFF_MIN   = 1.2;   // expose depth (world units) above which we terrace
const STEP_H      = 0.66;  // sub-box height per terrace step
const STEP_INSET  = 0.3;   // how far each lower step recedes on an exposed side
const STEP_MAX    = 3;     // cap sub-boxes per cliff cell (perf bound)
const EXPOSE_MIN  = 0.5;   // a side is "exposed" when its neighbour is this much lower

/** The four cardinal neighbour chunks' heightmaps (null when not yet streamed). */
export interface ChunkNeighbours {
  N?: HeightmapData | null;
  E?: HeightmapData | null;
  S?: HeightmapData | null;
  W?: HeightmapData | null;
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

      if (depth > CLIFF_MIN) {
        // ---- Terraced cliff: a stack of sub-boxes forming a bottom-wide
        // ziggurat. The BOTTOM box reaches the cliff lip (full footprint on the
        // exposed side); each HIGHER box steps BACK from the drop, so the face
        // descends as a visible staircase of ledges. The non-exposed side(s)
        // (toward an equal/higher neighbour) are never receded, so the top
        // surface stays welded to the adjacent plateau slab — only the exposed
        // drop side terraces. (Recede grows UPWARD, rec=(k-1-L)·INSET: an
        // earlier version grew it downward → an inverted/corbel overhang whose
        // full-width top lip hid the steps under it.)
        const expE = (h - hE) > EXPOSE_MIN;
        const expW = (h - hW) > EXPOSE_MIN;
        const expS = (h - hS) > EXPOSE_MIN;
        const expN = (h - hN) > EXPOSE_MIN;
        const k = Math.min(STEP_MAX, Math.max(2, Math.round(depth / STEP_H)));
        const bottom = h - depth;
        for (let L = 0; L < k; L++) {
          const zTop = h - L * STEP_H;
          const zBot = L === k - 1 ? bottom : Math.max(bottom, h - (L + 1) * STEP_H);
          const sz = zTop - zBot;
          if (sz <= 0.02) break;
          const rec = (k - 1 - L) * STEP_INSET;
          let x0 = offX + cx, x1 = offX + cx + 1;
          let y0 = offZ + cy, y1 = offZ + cy + 1;
          if (expE) x1 -= rec;
          if (expW) x0 += rec;
          if (expS) y1 -= rec;
          if (expN) y0 += rec;
          const sx = x1 - x0, sy = y1 - y0;
          if (sx < 0.12 || sy < 0.12) break;   // receded to a spire tip — stop
          bucket.push({
            cx: (x0 + x1) / 2,
            cy: (y0 + y1) / 2,
            cz: (zTop + zBot) / 2,
            sx, sy, sz,
            materialId: m,
          });
        }
        continue;
      }

      // Flat / shallow cell → one column box (top at h, floor at h-depth).
      bucket.push({
        cx: offX + cx + 0.5,
        cy: offZ + cy + 0.5,
        cz: h - depth / 2,
        sx: 1,
        sy: 1,
        sz: depth,
        materialId: m,
      });
    }
  }
  return byMat;
}
