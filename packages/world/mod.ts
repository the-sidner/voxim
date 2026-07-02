// @voxim/world — terrain model, chunk management, world generation
// Depends on: @voxim/engine, @voxim/codecs, @voxim/content (biome + zone defs), @voxim/levelgen (noise primitives)

export { Heightmap, MaterialGrid, OpenMask, KindGrid, VegFieldGrid, SurfaceStateGrid, WaterGrid } from "./src/components.ts";
export type { HeightmapData, MaterialGridData, OpenMaskData, KindGridData, VegFieldGridData, SurfaceStateGridData, WaterGridData } from "./src/components.ts";

export {
  TILE_SIZE,
  CHUNK_SIZE,
  CHUNK_CELLS,
  CHUNKS_PER_TILE_SIDE,
  CHUNKS_PER_TILE,
  HEIGHT_STEP,
  worldToChunk,
  worldToLocal,
  cellIndex,
  getHeight,
  getHeightInterp,
  getMaterial,
  snapHeight,
} from "./src/terrain.ts";

export { createChunk, setChunkHeights, setChunkMaterials, setChunkOpenness, setChunkKinds, setChunkVegField, setChunkSurfaceState, setChunkWater } from "./src/chunk.ts";

export { applyFieldsToChunks, buildTerrainBuffers, chunksFromBuffers, seedFromTileId } from "./src/generator.ts";
export type { GeneratedTile, WorldGenContent } from "./src/generator.ts";

export type {
  TerrainConfig,
  DomainWarpConfig,
  NoiseLayerConfig,
  TectonicConfig,
  DetailConfig,
  MoistureConfig,
  TemperatureConfig,
  HeightCurveConfig,
  SpawnZoneConfig,
  ErosionConfig,
  ZoneConfig,
} from "./src/terrain_config.ts";
export { DEFAULT_TERRAIN_CONFIG } from "./src/terrain_config.ts";

export { classifyBiome, biomeMaterialName } from "./src/biomes.ts";
export type { BiomeSample, BiomeMaterialSample } from "./src/biomes.ts";

export { classifyZone, getZoneAt } from "./src/zones.ts";
export type { ZoneGridData, ZoneCell, ZoneSample } from "./src/zones.ts";
