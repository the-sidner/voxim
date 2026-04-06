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

const tileId = Deno.args[0] ?? "tile_0";
const outPath = Deno.args[1] ?? `./terrain_${tileId}.bin`;
const seed = seedFromTileId(tileId);

console.log(`Generating terrain for tile "${tileId}" (seed=${seed})…`);
console.time("gen-terrain");

const { heightBuffer, materialBuffer, zoneGrid } = await buildTerrainBuffers(seed);
await saveTerrainCache(outPath, heightBuffer, materialBuffer, zoneGrid);

console.timeEnd("gen-terrain");
console.log(`Saved to ${outPath}`);
