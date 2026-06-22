/**
 * Atlas service entry point.
 *
 * Boot:
 *   1. Connect to Postgres.
 *   2. If no `worlds` rows exist, bootstrap one from env defaults so the
 *      stack has something to load. Otherwise leave existing worlds alone
 *      (they were baked deliberately).
 *   3. Start the HTTP server (worlds API + inspector UI + restart trigger).
 *
 * Environment:
 *   ATLAS_PORT            HTTP port. Default 8082.
 *   DATABASE_URL          Postgres URL. Required.
 *   VOXIM_SERVICE_SECRET  Shared secret gating /world/bake + /world/restart
 *                         (T-258). Required (>=16 chars) when VOXIM_ENV=production;
 *                         dev falls back to a default. Read endpoints stay public.
 *   VOXIM_ENV             "production" → fail closed when the secret is unset.
 *   BOOTSTRAP_WORLD_NAME  Name for the auto-baked world. Default "bootstrap".
 *   BOOTSTRAP_WORLD_SEED  Seed for the auto-bake. Default 1.
 *   BOOTSTRAP_WORLD_WIDTH  / _HEIGHT  Default 2 / 2.
 *
 * Atlas is the only writer of worlds. Tile-server + coordinator read.
 */
import {
  createPool,
  PgAtlasTileInitRepo,
  PgAtlasWorldRepo,
  PgWorldsRepo,
} from "@voxim/db";
import { JsonSource } from "@voxim/content";
import { resolveServiceSecret } from "@voxim/protocol";
import { startAtlasServer } from "./mod.ts";
import { bakeWorld } from "./src/bake.ts";

const port              = parseInt(Deno.env.get("ATLAS_PORT")            ?? "8082");
// Control-plane shared secret (T-258) — fails closed in production when unset.
const serviceSecret     = resolveServiceSecret();
const bootstrapName     =          Deno.env.get("BOOTSTRAP_WORLD_NAME")  ?? "bootstrap";
const bootstrapSeed     = parseInt(Deno.env.get("BOOTSTRAP_WORLD_SEED")  ?? "1");
const bootstrapWidth    = parseInt(Deno.env.get("BOOTSTRAP_WORLD_WIDTH") ?? "2");
const bootstrapHeight   = parseInt(Deno.env.get("BOOTSTRAP_WORLD_HEIGHT") ?? "2");

const pool       = createPool();
const worldsRepo = new PgWorldsRepo(pool);
const cellsRepo  = new PgAtlasWorldRepo(pool);
const tilesRepo  = new PgAtlasTileInitRepo(pool);

// Load the content store first — both the bootstrap bake and the bake
// HTTP endpoint thread it into `generateTile` so the POI-network stage
// populates real narratives (POIs + trinkets + stairs). Without content,
// every tile bakes with an empty narrative.
const content = await JsonSource.load();
console.log(`[Atlas] loaded content: ${content.pois.size} POIs · ${content.zones.size} zones`);

// Bootstrap a world only when none exist. Subsequent boots are no-ops
// against the worlds table — atlas leaves authored worlds in place and
// only adds new ones via the inspector's bake button.
const existing = await worldsRepo.getLatest();
if (!existing) {
  console.log(
    `[Atlas] no worlds present — baking bootstrap "${bootstrapName}" ` +
    `${bootstrapWidth}×${bootstrapHeight} @ seed ${bootstrapSeed}`,
  );
  const w = await bakeWorld(
    { worldsRepo, cellsRepo, tilesRepo, content },
    { name: bootstrapName, seed: bootstrapSeed, width: bootstrapWidth, height: bootstrapHeight },
  );
  console.log(`[Atlas] bootstrap baked: id=${w.id} (${w.width}×${w.height})`);
} else {
  console.log(
    `[Atlas] active world: ${existing.name} (${existing.width}×${existing.height}, ` +
    `seed ${existing.seed}, baked ${existing.bakedAt.toISOString()})`,
  );
}

startAtlasServer({ port, serviceSecret, worldsRepo, cellsRepo, tilesRepo, content });
