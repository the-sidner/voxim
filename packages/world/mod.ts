// @voxim/world — terrain model, chunk management, world generation
// Depends on: @voxim/engine, @voxim/codecs, @voxim/content (biome + zone defs)

export { Heightmap, MaterialGrid } from "./src/components.ts";
export type { HeightmapData, MaterialGridData } from "./src/components.ts";

export {
  TILE_SIZE,
  CHUNK_SIZE,
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

export { createChunk, setChunkHeights, setChunkMaterials } from "./src/chunk.ts";

export { buildTerrainBuffers, chunksFromBuffers, seedFromTileId } from "./src/generator.ts";
export type { GeneratedTile, WorldGenContent } from "./src/generator.ts";

export { saveTerrainCache, loadTerrainCache } from "./src/terrain_cache.ts";

export { valueNoise2D, fbm, ridgedFbm, billowFbm, domainWarp, voronoi2D } from "./src/noise.ts";

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
