/**
 * World coordinator entry point.
 *
 * Environment variables:
 *   GATEWAY_WT_URL          WebTransport URL of gateway,    default: https://gateway:8080
 *   VOXIM_SERVICE_SECRET    Shared secret matching gateway  required (>=16 chars) when
 *                                                           VOXIM_ENV=production; dev default
 *   VOXIM_ENV               "production" → fail closed when default: (unset → dev)
 *                           VOXIM_SERVICE_SECRET is unset
 *   TLS_CERT                Path to PEM cert (gateway uses  default: ./certs/cert.pem
 *                           same cert in dev — read here
 *                           to compute the hash for pinning)
 *   TICK_RATE               Macro tick rate in Hz           default: 1
 *   DATABASE_URL            Postgres connection string      required for persisted state
 *   COORDINATOR_HTTP_PORT   Read-only debug + macro queries default: 8083
 *   AI_MANAGER_URL          Base URL for the ai-manager     optional. When unset
 *                           service. When unset, runs       coordinator runs
 *                           utility-AI fallback only.       utility-AI only.
 *
 * The world map itself is owned by atlas — coordinator reads the active
 * world (latest baked) via WorldsRepo and seeds its world-graph aggregate
 * from atlas's baked tile_init rows.
 */
import { Coordinator } from "./mod.ts";
import {
  createPool,
  PgAtlasTileInitRepo,
  PgCityRepo,
  PgWorldsRepo,
} from "@voxim/db";
import { resolveServiceSecret } from "@voxim/protocol";

const gatewayWtUrl = Deno.env.get("GATEWAY_WT_URL") ?? "https://gateway:8080";
const certPath     = Deno.env.get("TLS_CERT")       ?? "./certs/cert.pem";
const tickRateHz   = parseInt(Deno.env.get("TICK_RATE") ?? "1");
const databaseUrl  = Deno.env.get("DATABASE_URL");
const aiManagerUrl = Deno.env.get("AI_MANAGER_URL");
const httpPort     = parseInt(Deno.env.get("COORDINATOR_HTTP_PORT") ?? "8083");

// Control-plane shared secret (T-258) — fails closed in production (VOXIM_ENV=
// production) when VOXIM_SERVICE_SECRET is unset; dev falls back to a default.
const serviceSecret = resolveServiceSecret();

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

const dbPool         = databaseUrl ? createPool({ databaseUrl }) : null;
const worldsRepo     = dbPool ? new PgWorldsRepo(dbPool)         : undefined;
const atlasTilesRepo = dbPool ? new PgAtlasTileInitRepo(dbPool)  : undefined;
const cityRepo       = dbPool ? new PgCityRepo(dbPool)           : undefined;

const coordinator = new Coordinator();
await coordinator.start({
  gatewayWtUrl,
  serviceSecret,
  gatewayCertHashHex,
  tickRateHz,
  ...(worldsRepo     ? { worldsRepo }     : {}),
  ...(atlasTilesRepo ? { atlasTilesRepo } : {}),
  ...(cityRepo       ? { cityRepo }       : {}),
  ...(aiManagerUrl   ? { aiManagerUrl }   : {}),
  httpPort,
});

await new Promise(() => {});
