/**
 * Gateway server entry point.
 *
 * Environment variables (all optional unless noted — defaults are for local dev):
 *   ADMIN_PORT              HTTP plain port for /account/*,   default: 8081
 *                           /gateway/connect, /register,
 *                           /handoff, /internal/*
 *   TLS_CERT                Path to PEM cert (for cert-hash   default: ./certs/cert.pem
 *                           computation only — no TLS listener)
 *   DATABASE_URL            Postgres connection string        required
 *   VOXIM_SERVICE_SECRET    Shared secret for tile→gateway    required (>=16 chars)
 *                           /internal/* calls                 dev default provided only when
 *                                                             not in production
 *
 * Note: the gateway intentionally serves plain HTTP. Browsers cannot pin
 * self-signed certs for fetch() (only for WebTransport via
 * serverCertificateHashes). Routing is request/response only — no game
 * data flows here, so unencrypted local dev traffic is acceptable. The
 * tile WebTransport that the client opens after the handshake DOES use
 * TLS with the cert hash returned from /gateway/connect.
 *
 * Tile registration: tiles self-register via POST /register on startup and
 * heartbeat to keep the registry warm (T-135). The gateway no longer
 * pre-registers stub tiles.
 *
 * Run:
 *   deno task gateway
 */
import { GatewayServer } from "./mod.ts";
import {
  createPool,
  PgUserRepo,
  PgHeritageRepo,
  PgSessionRepo,
  PgTileRepo,
} from "@voxim/db";

const port      = parseInt(Deno.env.get("ADMIN_PORT") ?? "8081");
const certPath  = Deno.env.get("TLS_CERT")            ?? "./certs/cert.pem";

const serviceSecret = Deno.env.get("VOXIM_SERVICE_SECRET")
  ?? "dev-local-only-do-not-use-in-prod-0000";

// Cert read for hash only (passed to clients so they can pin the tile's
// matching cert via WebTransport serverCertificateHashes). The gateway
// itself does not terminate TLS.
const cert = await Deno.readTextFile(certPath);

const pool = createPool();
const repos = {
  users:    new PgUserRepo(pool),
  heritage: new PgHeritageRepo(pool),
  sessions: new PgSessionRepo(pool),
  tiles:    new PgTileRepo(pool),
};

const server = new GatewayServer();
await server.start({
  port,
  cert,
  repos,
  serviceSecret,
});
