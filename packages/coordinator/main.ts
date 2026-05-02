/**
 * World coordinator entry point.
 *
 * Environment variables:
 *   GATEWAY_WT_URL          WebTransport URL of gateway,    default: https://gateway:8080
 *   VOXIM_SERVICE_SECRET    Shared secret matching gateway  required (>=16 chars)
 *   TLS_CERT                Path to PEM cert (gateway uses  default: ./certs/cert.pem
 *                           same cert in dev — read here
 *                           to compute the hash for pinning)
 *   TICK_RATE               Macro tick rate in Hz           default: 1
 *   DATABASE_URL            Postgres connection string      required for world map
 *                                                           persistence (T-138)
 *   WORLD_SEED              Integer seed for first-time     default: 1
 *                           world map generation
 *   WORLD_TILES             Comma-separated tile ids the    default: tile_0,tile_1,tile_2,tile_3
 *                           world map covers; length must
 *                           equal WORLD_WIDTH × WORLD_HEIGHT
 *   WORLD_WIDTH             Macro grid width                default: 2
 *   WORLD_HEIGHT            Macro grid height               default: 2
 */
import { Coordinator } from "./mod.ts";
import { createPool, PgWorldMapRepo, PgCityRepo } from "@voxim/db";

const gatewayWtUrl = Deno.env.get("GATEWAY_WT_URL") ?? "https://gateway:8080";
const certPath     = Deno.env.get("TLS_CERT")       ?? "./certs/cert.pem";
const tickRateHz   = parseInt(Deno.env.get("TICK_RATE") ?? "1");
const databaseUrl  = Deno.env.get("DATABASE_URL");
const worldSeed    = parseInt(Deno.env.get("WORLD_SEED")   ?? "1");
const worldWidth   = parseInt(Deno.env.get("WORLD_WIDTH")  ?? "2");
const worldHeight  = parseInt(Deno.env.get("WORLD_HEIGHT") ?? "2");
const worldTileIds = (Deno.env.get("WORLD_TILES") ?? "tile_0,tile_1,tile_2,tile_3")
  .split(",").map((s) => s.trim()).filter(Boolean);

const serviceSecret = Deno.env.get("VOXIM_SERVICE_SECRET")
  ?? "dev-local-only-do-not-use-in-prod-0000";

// Gateway cert hash for self-signed dev pinning (skipped automatically
// when the cert isn't available — production CA-signed certs cover this).
let gatewayCertHashHex: string | undefined;
try {
  const cert = await Deno.readTextFile(certPath);
  const b64 = cert.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const buf = await crypto.subtle.digest("SHA-256", der);
  gatewayCertHashHex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
} catch (err) {
  console.warn(`[Coordinator] no cert at ${certPath} (${(err as Error).message}); proceeding without cert pinning`);
}

const dbPool = databaseUrl ? createPool({ databaseUrl }) : null;
const worldMapRepo = dbPool ? new PgWorldMapRepo(dbPool) : undefined;
const cityRepo = dbPool ? new PgCityRepo(dbPool) : undefined;

const coordinator = new Coordinator();
await coordinator.start({
  gatewayWtUrl,
  serviceSecret,
  gatewayCertHashHex,
  tickRateHz,
  ...(worldMapRepo ? { worldMapRepo } : {}),
  ...(cityRepo ? { cityRepo } : {}),
  worldSeed,
  worldTileIds,
  worldWidth,
  worldHeight,
});

await new Promise(() => {});
