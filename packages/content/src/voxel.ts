/**
 * The voxel atom (T-281) — the input currency of the client rebuild's central
 * voxel pipeline. One THREE-free struct, shared server↔client, that subsumes the
 * four divergent voxel representations (per-node entity meshes, merged prop
 * geometry, terrain quads, the build ghost) into one: a flat list of atoms fed to
 * the single `bakeVoxels` kitchen.
 *
 * Two deliberate decisions (see CLIENT_REBUILD_PLAN.md §2.1):
 *   - CENTER + FULL edge lengths, not min-corner + size — the bake math scales the
 *     ±0.5 unit-box template by sx/sy/sz about the voxel center, so sx=1 spans
 *     [−0.5,+0.5] (an edge length of 1, NOT a half-extent).
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
  /**
   * Per-voxel FULL edge lengths in model space (the "different sizes" axis):
   * `bakeDisplacedVoxel` scales the ±0.5 unit box by these directly, so sx=1
   * spans [−0.5,+0.5]. (NOT half-extents — the math is authoritative; T-285a.)
   */
  sx: number;
  sy: number;
  sz: number;
  /** Indexes the content material registry → palette. The only color carrier. */
  materialId: number;
  /** Addressing tag for editable/placed voxels (0 = baked-static terrain/model). */
  vid?: number;
  /**
   * Moss-creep blend factor 0..1 (T-311 P4, G6 per-voxel render attribute) —
   * how far this voxel's colour lerps toward `MaterialDef.render.mossBlend`'s
   * target material. DATA, not colour: derived from the server-authoritative
   * SurfaceStateGrid.overgrowth × the content-authored floor/wall bias; the
   * moss COLOUR still resolves downstream from the palette (materialId stays
   * the only colour carrier). Absent ⇒ bakes byte-identically.
   */
  moss01?: number;
  /**
   * Per-voxel wetness sample 0..1 (T-311 P4, G6 sidecar) — the cell's
   * SurfaceStateGrid.wetness, emitted into an `aWetness` vertex attribute so
   * the `wet_specular` surface treatment (G4) can darken + gloss in-shader.
   * DATA only — the response params live on `MaterialDef.render.wetness`.
   * Absent ⇒ no attribute, bakes byte-identically.
   */
  wet01?: number;
  /**
   * Per-voxel corner-displacement magnitude override (T-311 P4). Cliff-stack
   * stones set this ABOVE the constant terrain mag so their corners read
   * chunky and — because a shared vertex then displaces differently on each
   * side of a stone seam — the seams open into deliberate chinks (the
   * hand-stacked look). Absent ⇒ the bake call's mag (byte-identical).
   */
  dispMag?: number;
  /**
   * Per-voxel displacement DECORRELATION seed (T-311 P4). The default
   * displacement is seeded by shared world position so coincident vertices
   * weld (continuous surfaces). A voxel carrying `dispSeed` warps its corners
   * INDEPENDENTLY of every neighbour — voxels visibly poke out of the merged
   * mesh and clip into each other (deliberate), and each gets its own facet
   * normals → per-voxel light variation. The individual-stone look. Absent ⇒
   * welded (byte-identical).
   */
  dispSeed?: number;
}
