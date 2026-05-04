/**
 * @voxim/atlas — procedural level service.
 *
 * Owns world-map and tile-map generation end-to-end. Writes outputs into the
 * shared DB; tile-server reads them at boot and applies player edits on top.
 *
 * See DESIGN.md for the architectural plan and phased rollout.
 */
export { startAtlasServer } from "./src/server.ts";
export type { AtlasServerConfig } from "./src/server.ts";
export { bakeWorld, tileSeedFor } from "./src/bake.ts";
export type { BakeInput, BakeDeps } from "./src/bake.ts";
export { DEFAULT_GEN_PARAMS, PRESETS, mergeGenParams } from "./src/genparams.ts";
export type { GenParams, DeepPartialGenParams } from "./src/genparams.ts";

export { generateWorldMap } from "./src/worldmap/generate.ts";
export type {
  Edge,
  GateSpec,
  BiomeParams,
  RiverEndpoint,
  RiverSegment,
  WorldCellRecord,
  WorldMap,
} from "./src/worldmap/types.ts";
export { EDGES } from "./src/worldmap/types.ts";

export { generateTile, tileInitToWire, tileInitFromWire } from "./src/tilemap/generate.ts";
export type { GenerateTileOptions } from "./src/tilemap/generate.ts";
export type { Room, Portal, TileInit, TileInitWire } from "./src/tilemap/types.ts";
export { deriveGateSummary, reachable, nibbleAt, NO_GATE } from "./src/tilemap/summary.ts";
export { runTerrain, WALL_HEIGHT } from "./src/tilemap/pipeline/terrain.ts";
export {
  runMaterials,
  MATERIAL_NONE, MATERIAL_GRASS, MATERIAL_DIRT,
  MATERIAL_STONE, MATERIAL_SAND, MATERIAL_WATER,
} from "./src/tilemap/pipeline/materials.ts";
export {
  runBoundaryKinds,
  BOUNDARY_KIND_OPEN, BOUNDARY_KIND_CLIFF,
  BOUNDARY_KIND_VEGETATION, BOUNDARY_KIND_WATER,
} from "./src/tilemap/pipeline/boundary_kinds.ts";
export { upsampleTile } from "./src/tilemap/upsample.ts";
export type { UpsampleOptions, UpsampleOutput } from "./src/tilemap/upsample.ts";
