/**
 * The voxel atom (T-281) — the input currency of the client rebuild's central
 * voxel pipeline. One THREE-free struct, shared server↔client, that subsumes the
 * four divergent voxel representations (per-node entity meshes, merged prop
 * geometry, terrain quads, the build ghost) into one: a flat list of atoms fed to
 * the single `bakeVoxels` kitchen.
 *
 * Two deliberate decisions (see CLIENT_REBUILD_PLAN.md §2.1):
 *   - CENTER + half-extents, not min-corner + size — the bake math already scales
 *     the ±0.5 unit-box template about the voxel center.
 *   - PER-VOXEL size on the atom (sx/sy/sz), not a single per-entity scale — this
 *     is the mechanical unlock for "voxels of different sizes": coarse terrain and
 *     fine detail bake through the exact same path with different extents.
 *
 * Coordinates are MODEL space (x=right, y=forward, z=up); the renderer converts to
 * Three.js via the one `modelToThree` helper. `materialId` is the ONLY color
 * carrier — color resolves downstream from the content palette, never stored here.
 */
export interface VoxelAtom {
  /** Voxel CENTER in model space. */
  cx: number;
  cy: number;
  cz: number;
  /** Per-voxel half-extents in model space (the "different sizes" axis). */
  sx: number;
  sy: number;
  sz: number;
  /** Indexes the content material registry → palette. The only color carrier. */
  materialId: number;
  /** Addressing tag for editable/placed voxels (0 = baked-static terrain/model). */
  vid?: number;
}
