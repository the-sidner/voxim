/**
 * Tile server entry point.
 *
 * Environment variables (all optional unless noted — defaults work for local dev):
 *   TILE_ID         Tile identifier                   default: tile_0
 *   PORT            WebTransport HTTPS port           default: 4434
 *   ADMIN_PORT      Plain HTTP admin port             default: 14434
 *   ADMIN_HOST      Hostname the gateway uses to        default: $HOSTNAME or "localhost"
 *                   reach this tile's admin port.       Docker sets HOSTNAME to the
 *                   In docker compose the container's   container hostname (which
 *                   hostname matches the service name   matches the service name in
 *                   (tile-1 → "tile-1"), which the      compose), so the default is
 *                   gateway can resolve.                correct in compose; outside
 *                                                       compose it falls back to
 *                                                       "localhost".
 *   TLS_CERT        Path to PEM TLS certificate       default: ./certs/cert.pem
 *   TLS_KEY         Path to PEM TLS private key       default: ./certs/key.pem
 *   TICK_RATE       Tick rate in Hz                   default: 20
 *   TILE_ADDRESS    Address advertised to clients     default: 127.0.0.1:4434
 *   GATEWAY_URL     Gateway base URL for registration default: (none — skips self-registration)
 *   DATABASE_URL    Postgres connection string        REQUIRED — atlas terrain comes from DB
 *   WORLD_WIDTH     Macro-grid width in cells         default: 2 (must match atlas)
 *   DATA_DIR        Content data directory            default: (resolved by loader)
 *   DEV_MODE        Disable cheat commands (0/false)  default: true
 *
 * Persistence: world snapshots are stored in the `tile_saves` table (one row
 * per TILE_ID). Restart the container with the same TILE_ID and it picks up
 * where it left off. Initial terrain (when no save exists) comes from atlas's
 * `atlas_tile_init` table — atlas must be up and have generated this world's
 * tiles before this server can boot.
 *
 * Run:
 *   deno task tile
 */
import { TileServer } from "./mod.ts";
import {
  createPool,
  PgAtlasTileInitRepo,
  PgAtlasWorldRepo,
  PgTileSaveRepo,
  PgWorldsRepo,
} from "@voxim/db";

// Prevent WebTransport session timeouts and other async edge-cases from
// crashing the process. These are expected during normal client disconnects.
//
// We log the FULL error including stack so unexpected rejections (anything
// that isn't a known WT-disconnect shape) are at least diagnosable rather
// than silently disappearing.
globalThis.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const msg = (reason as Error)?.message ?? String(reason);
  const stack = (reason as Error)?.stack;
  if (stack) {
    console.warn("[TileServer] unhandled rejection (suppressed):", msg, "\n", stack);
  } else {
    console.warn("[TileServer] unhandled rejection (suppressed):", msg);
  }
  event.preventDefault();
});

// T-257: parseTileId requires "<x>_<y>" — the old default "tile_0" could
// never boot the documented `deno task tile` / `demo` paths.
const tileId         = Deno.env.get("TILE_ID")      ?? "0_0";
const port           = parseInt(Deno.env.get("PORT")       ?? "4434");
const adminPort      = parseInt(Deno.env.get("ADMIN_PORT") ?? "14434");
// Default to $HOSTNAME (docker sets it to the container hostname) so the
// gateway can reach this tile's admin port. Falls back to "localhost" for
// single-process local dev. Avoids Deno.hostname() so we don't need --allow-sys.
const adminHost      = Deno.env.get("ADMIN_HOST") ?? Deno.env.get("HOSTNAME") ?? "localhost";
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

// Atlas is the source of truth for terrain — DATABASE_URL is now required
// (tile-server can no longer generate its own terrain). All repos share one pool.
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required: tile-server reads its tile_init from the atlas service via Postgres.");
}
const pool       = createPool({ databaseUrl });
const tileSaves  = new PgTileSaveRepo(pool);
const worlds     = new PgWorldsRepo(pool);
const atlasCells = new PgAtlasWorldRepo(pool);
const atlasTiles = new PgAtlasTileInitRepo(pool);

const server = new TileServer();
await server.start({
  tileId,
  port,
  cert,
  key,
  tickRateHz,
  adminPort,
  adminHost,
  tileAddress,
  ...(gatewayUrl     ? { gatewayUrl }     : {}),
  ...(gatewayWtUrl   ? { gatewayWtUrl }   : {}),
  ...(serviceSecret  ? { serviceSecret }  : {}),
  tileSaves,
  worlds,
  atlasCells,
  atlasTiles,
  ...(dataDir        ? { dataDir }        : {}),
  devMode,
});
