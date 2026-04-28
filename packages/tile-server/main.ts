/**
 * Tile server entry point.
 *
 * Environment variables (all optional unless noted — defaults work for local dev):
 *   TILE_ID         Tile identifier                   default: tile_0
 *   PORT            WebTransport HTTPS port           default: 4434
 *   ADMIN_PORT      Plain HTTP admin port             default: 14434
 *   TLS_CERT        Path to PEM TLS certificate       default: ./certs/cert.pem
 *   TLS_KEY         Path to PEM TLS private key       default: ./certs/key.pem
 *   TICK_RATE       Tick rate in Hz                   default: 20
 *   TILE_ADDRESS    Address advertised to clients     default: 127.0.0.1:4434
 *   GATEWAY_URL     Gateway base URL for registration default: (none — skips self-registration)
 *   DATABASE_URL    Postgres connection string        default: (none — ephemeral, no persistence)
 *   DATA_DIR        Content data directory            default: (resolved by loader)
 *   DEV_MODE        Disable cheat commands (0/false)  default: true
 *
 * Persistence: when DATABASE_URL is set, world snapshots are stored in the
 * `tile_saves` table (one row per TILE_ID). Restart the container with the
 * same TILE_ID and it picks up where it left off.
 *
 * Run:
 *   deno task tile
 */
import { TileServer } from "./mod.ts";
import { createPool, PgTileSaveRepo, PgWorldMapRepo } from "@voxim/db";

// Prevent WebTransport session timeouts and other async edge-cases from
// crashing the process. These are expected during normal client disconnects.
globalThis.addEventListener("unhandledrejection", (event) => {
  console.warn("[TileServer] unhandled rejection (suppressed):", (event.reason as Error)?.message ?? event.reason);
  event.preventDefault();
});

const tileId         = Deno.env.get("TILE_ID")      ?? "tile_0";
const port           = parseInt(Deno.env.get("PORT")       ?? "4434");
const adminPort      = parseInt(Deno.env.get("ADMIN_PORT") ?? "14434");
const certPath       = Deno.env.get("TLS_CERT")     ?? "./certs/cert.pem";
const keyPath        = Deno.env.get("TLS_KEY")      ?? "./certs/key.pem";
const tickRateHz     = parseInt(Deno.env.get("TICK_RATE")  ?? "20");
const tileAddress    = Deno.env.get("TILE_ADDRESS") ?? `127.0.0.1:${port}`;
const gatewayUrl     = Deno.env.get("GATEWAY_URL");      // undefined → no self-registration
const gatewayWtUrl   = Deno.env.get("GATEWAY_WT_URL");   // undefined → no event channel
const serviceSecret  = Deno.env.get("VOXIM_SERVICE_SECRET");
const databaseUrl    = Deno.env.get("DATABASE_URL");     // undefined → ephemeral
const dataDir        = Deno.env.get("DATA_DIR");         // undefined → default loader path
const devMode        = !["0", "false"].includes(Deno.env.get("DEV_MODE") ?? "");

const cert = await Deno.readTextFile(certPath);
const key  = await Deno.readTextFile(keyPath);

// Persistence is opt-in by DATABASE_URL — no DB means no save/load. Useful
// for ephemeral test runs and the early bootstrap path before the DB stack
// is up. Both repos share one pool.
const pool = databaseUrl ? createPool({ databaseUrl }) : null;
const tileSaves = pool ? new PgTileSaveRepo(pool) : undefined;
const worldMap  = pool ? new PgWorldMapRepo(pool) : undefined;

const server = new TileServer();
await server.start({
  tileId,
  port,
  cert,
  key,
  tickRateHz,
  adminPort,
  tileAddress,
  ...(gatewayUrl     ? { gatewayUrl }     : {}),
  ...(gatewayWtUrl   ? { gatewayWtUrl }   : {}),
  ...(serviceSecret  ? { serviceSecret }  : {}),
  ...(tileSaves      ? { tileSaves }      : {}),
  ...(worldMap       ? { worldMap }       : {}),
  ...(dataDir        ? { dataDir }        : {}),
  devMode,
});
