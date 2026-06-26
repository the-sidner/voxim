/**
 * Curated render barrel for the Studio devtool (T-311 Phase 1). Re-exports the
 * REAL shipped voxel-bake + material runtime so the Studio Material / ProcModel
 * panels preview through the exact code path the game uses — the Swing-Inspector
 * discipline: no re-implementation, no drift. Deliberately narrow (the bake
 * kitchen + the material / texture factory only, never game.ts or networking) so
 * the studio bundle stays lean. Exposed as the `@voxim/client/render` subpath.
 */
export { bakeVoxels, bakeSubModel } from "./voxel_bake.ts";
export type { BakedMesh, TintJitter } from "./voxel_bake.ts";
export { geometryFromBaked } from "./voxel_geo.ts";
export { buildVoxelMaterial } from "./voxel_material.ts";
export {
  getVoxelTexture,
  textureStyleIds,
  registerBuiltinTextureStyles,
  disposeVoxelTextures,
} from "./material_textures.ts";
export { registerBuiltinGenerators, getGenerator, generatorIds } from "./procmodel/mod.ts";
export type { Generator, GeneratorContext } from "./procmodel/mod.ts";
