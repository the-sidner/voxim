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
 *   VOXIM_SERVICE_SECRET    Shared secret gating the control   required (>=16 chars) when
 *                           plane (/register, /heartbeat,      VOXIM_ENV=production; dev
 *                           /handoff, /internal/*)             falls back to a dev default
 *   VOXIM_ENV               "production" → fail closed when    default: (unset → dev)
 *                           VOXIM_SERVICE_SECRET is unset
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
  PgUserTileFogRepo,
} from "@voxim/db";
import { resolveServiceSecret } from "@voxim/protocol";
import { ensureFreshDevCert } from "../../scripts/dev_cert.ts";

const port      = parseInt(Deno.env.get("ADMIN_PORT") ?? "8081");
const wtPort    = parseInt(Deno.env.get("WT_PORT")    ?? "8080");
const certPath  = Deno.env.get("TLS_CERT")            ?? "./certs/cert.pem";
const keyPath   = Deno.env.get("TLS_KEY")             ?? "./certs/key.pem";

// Control-plane shared secret (T-258) — fails closed in production (VOXIM_ENV=
// production) when VOXIM_SERVICE_SECRET is unset; falls back to a dev default
// otherwise so a single-machine stack talks to itself.
const serviceSecret = resolveServiceSecret();

// Cert hash is returned to clients so they can pin the tile's matching cert
// via WebTransport serverCertificateHashes. The gateway also uses the same
// cert + key to terminate TLS for its own service WT listener (T-137).
//
// Self-heal the shared dev cert (T-267): the gateway hashes the same
// ./certs/cert.pem the tile serves, so both must agree on a CURRENT cert.
// `ensureFreshDevCert` is idempotent, so whichever of gateway/tile boots first
// regenerates an expired cert and the other reads the same fresh one — no
// boot-order hash mismatch. Skipped when TLS_CERT is supplied (prod manages it).
if (!Deno.env.get("TLS_CERT")) {
  await ensureFreshDevCert(certPath, keyPath);
}

const cert = await Deno.readTextFile(certPath);
const key  = await Deno.readTextFile(keyPath);

const pool = createPool();
const repos = {
  users:    new PgUserRepo(pool),
  heritage: new PgHeritageRepo(pool),
  sessions: new PgSessionRepo(pool),
  tiles:    new PgTileRepo(pool),
  userFog:  new PgUserTileFogRepo(pool),
};

const server = new GatewayServer();
await server.start({
  port,
  wtPort,
  cert,
  key,
  repos,
  serviceSecret,
});
