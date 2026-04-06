/**
 * Gateway server entry point.
 *
 * Environment variables (all optional — defaults work for local dev):
 *   PORT            HTTP/3 WebTransport port          default: 8080
 *   TLS_CERT        Path to PEM TLS certificate       default: ./certs/cert.pem
 *   TLS_KEY         Path to PEM TLS private key       default: ./certs/key.pem
 *   TILE_ID         Initial tile ID to pre-register   default: tile_0
 *   TILE_ADDRESS    Tile WebTransport address          default: 127.0.0.1:4434
 *   TILE_ADMIN_URL  Tile admin HTTP URL                default: http://127.0.0.1:14434
 *
 * Run:
 *   deno task gateway
 *   deno run --allow-net --allow-read --allow-env --unstable-net packages/gateway/main.ts
 */
import { GatewayServer } from "./mod.ts";

const port        = parseInt(Deno.env.get("PORT")           ?? "8080");
const certPath    = Deno.env.get("TLS_CERT")                ?? "./certs/cert.pem";
const keyPath     = Deno.env.get("TLS_KEY")                 ?? "./certs/key.pem";
const tileId      = Deno.env.get("TILE_ID")                 ?? "tile_0";
const tileAddress = Deno.env.get("TILE_ADDRESS")            ?? "127.0.0.1:4434";
const tileAdmin   = Deno.env.get("TILE_ADMIN_URL")          ?? "http://127.0.0.1:14434";

const cert = await Deno.readTextFile(certPath);
const key  = await Deno.readTextFile(keyPath);

const server = new GatewayServer();
server.start({
  port,
  cert,
  key,
  initialTiles: [{ tileId, address: tileAddress, adminUrl: tileAdmin }],
});
