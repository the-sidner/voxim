/**
 * Atlas service entry point.
 *
 * Boot sequence:
 *   1. Connect to Postgres.
 *   2. Ensure a worldmap exists for the configured (worldId, seed). If not,
 *      generate it deterministically and persist.
 *   3. Start the HTTP server (health + worldmap API + inspector UI).
 *
 * Environment variables:
 *   ATLAS_PORT     HTTP port to listen on. Default 8082.
 *   DATABASE_URL   Postgres connection string. Required.
 *   WORLD_ID       Logical world identifier. Default "default".
 *   WORLD_SEED     Worldmap seed. Default 1.
 *   WORLD_WIDTH    Macro grid width in cells. Default 4.
 *   WORLD_HEIGHT   Macro grid height in cells. Default 4.
 */
import { createPool, PgAtlasTileInitRepo, PgAtlasWorldRepo } from "@voxim/db";
import { startAtlasServer } from "./mod.ts";
import { generateWorldMap } from "./src/worldmap/generate.ts";
import { generateTile, tileInitToWire } from "./src/tilemap/generate.ts";

const port    = parseInt(Deno.env.get("ATLAS_PORT")   ?? "8082");
const worldId = Deno.env.get("WORLD_ID")              ?? "default";
const seed    = parseInt(Deno.env.get("WORLD_SEED")   ?? "1");
const width   = parseInt(Deno.env.get("WORLD_WIDTH")  ?? "4");
const height  = parseInt(Deno.env.get("WORLD_HEIGHT") ?? "4");

const pool      = createPool();
const worldRepo = new PgAtlasWorldRepo(pool);
const tileRepo  = new PgAtlasTileInitRepo(pool);

// Ensure a worldmap exists for this (worldId, seed). If the persisted seed
// differs from the configured one, regenerate — seed change = different world.
const existing = await worldRepo.load(worldId);
if (!existing || Number(existing.seed) !== seed) {
  console.log(
    existing
      ? `[Atlas] persisted seed ${existing.seed} ≠ configured ${seed} — regenerating worldmap`
      : `[Atlas] no worldmap present — generating ${width}×${height} @ seed ${seed}`,
  );
  const wm = generateWorldMap(seed, width, height);
  await worldRepo.save({
    worldId,
    seed: BigInt(seed),
    cells: wm.cells.map((c) => ({
      cellX: c.cellX,
      cellY: c.cellY,
      biome: c.biome as unknown as Record<string, unknown>,
      gates: c.gates as unknown as Record<string, unknown>,
      rivers: c.rivers as unknown as unknown[],
    })),
  });
  // Worldmap re-seeded → all existing tile_init rows are stale.
  await tileRepo.deleteAll(worldId);
  // Eagerly populate tile_init for every cell so the inspector has full
  // summary coverage on first boot.
  for (const cell of wm.cells) {
    const tileSeed = tileSeedForBoot(seed, cell.cellX, cell.cellY);
    const t = generateTile(cell, tileSeed);
    await tileRepo.put({
      worldId,
      tileId:  `${cell.cellX}_${cell.cellY}`,
      cellX:   cell.cellX,
      cellY:   cell.cellY,
      seed:    BigInt(tileSeed),
      payload: tileInitToWire(t) as unknown as Record<string, unknown>,
    });
  }
  console.log(`[Atlas] persisted ${wm.cells.length} cells + ${wm.cells.length} tile_init rows`);
} else {
  console.log(`[Atlas] worldmap loaded (seed ${existing.seed}, ${existing.cells.length} cells)`);
}

startAtlasServer({ port, worldRepo, tileRepo, worldId });

/**
 * Same hash used in server.ts. Duplicated here rather than re-exported so
 * main.ts doesn't import server internals beyond the entry point — keeps
 * the boot path obvious in one file.
 */
function tileSeedForBoot(worldSeed: number, cellX: number, cellY: number): number {
  return ((worldSeed * 0x9e3779b1) ^ (cellX * 73856093) ^ (cellY * 19349663)) >>> 0;
}
