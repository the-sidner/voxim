/**
 * Tile server entry point.
 *
 * Environment variables (all optional — defaults work for local dev):
 *   TILE_ID         Tile identifier                   default: tile_0
 *   PORT            WebTransport HTTPS port            default: 4434
 *   ADMIN_PORT      Plain HTTP admin port              default: 14434
 *   TLS_CERT        Path to PEM TLS certificate       default: ./certs/cert.pem
 *   TLS_KEY         Path to PEM TLS private key       default: ./certs/key.pem
 *   TICK_RATE       Tick rate in Hz                   default: 20
 *   TILE_ADDRESS    Address advertised to clients      default: 127.0.0.1:4434
 *   GATEWAY_URL     Gateway base URL for registration default: (none — skips self-registration)
 *   SAVE_DIR        Directory for world save files    default: (none — ephemeral)
 *   DATA_DIR        Content data directory            default: (resolved by loader)
 *   DEV_MODE        Disable cheat commands (0/false)  default: true
 *
 * Run:
 *   deno task tile
 *   deno run --allow-net --allow-read --allow-write --allow-env --unstable-net packages/tile-server/main.ts
 */
import { TileServer } from "./mod.ts";

// Prevent WebTransport session timeouts and other async edge-cases from
// crashing the process.  These are expected during normal client disconnects.
globalThis.addEventListener("unhandledrejection", (event) => {
  console.warn("[TileServer] unhandled rejection (suppressed):", (event.reason as Error)?.message ?? event.reason);
  event.preventDefault();
});

const tileId      = Deno.env.get("TILE_ID")      ?? "tile_0";
const port        = parseInt(Deno.env.get("PORT")       ?? "4434");
const adminPort   = parseInt(Deno.env.get("ADMIN_PORT") ?? "14434");
const certPath    = Deno.env.get("TLS_CERT")     ?? "./certs/cert.pem";
const keyPath     = Deno.env.get("TLS_KEY")      ?? "./certs/key.pem";
const tickRateHz  = parseInt(Deno.env.get("TICK_RATE")  ?? "20");
const tileAddress = Deno.env.get("TILE_ADDRESS") ?? `127.0.0.1:${port}`;
const gatewayUrl  = Deno.env.get("GATEWAY_URL");   // undefined → no self-registration
const saveDir     = Deno.env.get("SAVE_DIR");       // undefined → ephemeral (no persistence)
const dataDir     = Deno.env.get("DATA_DIR");       // undefined → default loader path
const devMode     = !["0", "false"].includes(Deno.env.get("DEV_MODE") ?? "");

const cert = await Deno.readTextFile(certPath);
const key  = await Deno.readTextFile(keyPath);

const server = new TileServer();
await server.start({
  tileId,
  port,
  cert,
  key,
  tickRateHz,
  adminPort,
  tileAddress,
  ...(gatewayUrl ? { gatewayUrl } : {}),
  ...(saveDir    ? { saveDir }    : {}),
  ...(dataDir    ? { dataDir }    : {}),
  devMode,
});
