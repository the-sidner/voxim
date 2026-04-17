/**
 * Terrain generation script.
 *
 * Generates a terrain cache file for the given tile ID and writes it to disk.
 * The tile-server requires this file to exist before it can start.
 *
 * Usage:
 *   deno task gen-terrain [tileId] [outputPath]
 *
 * Defaults:
 *   tileId      = "tile_0"
 *   outputPath  = ./terrain_<tileId>.bin
 */

import { buildTerrainBuffers, saveTerrainCache, seedFromTileId } from "@voxim/world";
import type { WorldGenContent } from "@voxim/world";
import { loadContentStore } from "@voxim/content";

const tileId = Deno.args[0] ?? "tile_0";
const outPath = Deno.args[1] ?? `./terrain_${tileId}.bin`;
const seed = seedFromTileId(tileId);

console.log(`Generating terrain for tile "${tileId}" (seed=${seed})…`);
console.time("gen-terrain");

const content = await loadContentStore();

const worldGenContent: WorldGenContent = {
  biomes: content.getAllBiomes(),
  zones: content.getAllZones(),
  resolveMaterialId(name: string): number {
    const m = content.getMaterialByName(name);
    if (!m) throw new Error(`unknown material "${name}" referenced from biome data`);
    return m.id;
  },
};

const { heightBuffer, materialBuffer, zoneGrid } = await buildTerrainBuffers(seed, worldGenContent);
await saveTerrainCache(outPath, heightBuffer, materialBuffer, zoneGrid);

console.timeEnd("gen-terrain");
console.log(`Saved to ${outPath}`);
