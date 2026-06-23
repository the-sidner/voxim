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
 * Constant per-corner displacement magnitude for ALL terrain atoms — 10 % of the
 * height quantum. Pinned (not the per-voxel `0.10 * min(size)`) so variable-depth
 * column boxes don't crack at shared corners. Passed to `bakeVoxels(atoms, mat, mag)`.
 */
export const TERRAIN_DISP_MAG = 0.10 * HEIGHT_STEP;

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

      const hMinNbr = Math.min(
        neigh(cx, cy, "N", h),
        neigh(cx, cy, "E", h),
        neigh(cx, cy, "S", h),
        neigh(cx, cy, "W", h),
      );
      // Exposed vertical extent below the top, floored to one step (flat plateau
      // cell → a thin slab whose underside hides beneath equal-height neighbours).
      const depth = Math.max(h - Math.min(h, hMinNbr), HEIGHT_STEP);

      const atom: VoxelAtom = {
        cx: offX + cx + 0.5, // cell centre, east
        cy: offZ + cy + 0.5, // cell centre, south
        cz: h - depth / 2,   // vertical centre: top at h, bottom at h-depth
        sx: 1,
        sy: 1,
        sz: depth,           // full edge size; the per-voxel-size unlock = cliff depth
        materialId: m,
        // vid omitted → baked-static terrain
      };

      let bucket = byMat.get(m);
      if (!bucket) byMat.set(m, bucket = []);
      bucket.push(atom);
    }
  }
  return byMat;
}
