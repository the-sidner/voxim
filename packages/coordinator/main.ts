/**
 * World coordinator entry point.
 *
 * Environment variables:
 *   GATEWAY_WT_URL          WebTransport URL of gateway,    default: https://gateway:8080
 *                           e.g. https://gateway:8080
 *   VOXIM_SERVICE_SECRET    Shared secret matching gateway  required (>=16 chars)
 *   TLS_CERT                Path to PEM cert (gateway uses  default: ./certs/cert.pem
 *                           same cert in dev — read here
 *                           to compute the hash for pinning)
 *   TICK_RATE               Macro tick rate in Hz           default: 1
 *   DATABASE_URL            (T-138) Postgres connection      default: (none — world map
 *                           string for world_map / cities    state not persisted)
 *
 * Run:
 *   deno run --allow-net --allow-read --allow-env --unstable-net packages/coordinator/main.ts
 */
import { Coordinator } from "./mod.ts";

const gatewayWtUrl = Deno.env.get("GATEWAY_WT_URL") ?? "https://gateway:8080";
const certPath     = Deno.env.get("TLS_CERT")       ?? "./certs/cert.pem";
const tickRateHz   = parseInt(Deno.env.get("TICK_RATE") ?? "1");

const serviceSecret = Deno.env.get("VOXIM_SERVICE_SECRET")
  ?? "dev-local-only-do-not-use-in-prod-0000";

// Compute the gateway's cert hash from the shared cert file (dev). In
// production the gateway serves a CA-signed cert and this is omitted.
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

const coordinator = new Coordinator();
await coordinator.start({
  gatewayWtUrl,
  serviceSecret,
  gatewayCertHashHex,
  tickRateHz,
});

// Keep the process alive — the tickloop is driven by setInterval and Deno
// would otherwise exit immediately after start() returns.
await new Promise(() => {});
