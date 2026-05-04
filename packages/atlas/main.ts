/**
 * Atlas service entry point.
 *
 * Phase 0: just stands up the HTTP server with /health. No worldmap, no
 * tilemap, no inspector content yet.
 *
 * Environment variables:
 *   ATLAS_PORT   HTTP port to listen on. Default 8082.
 */
import { startAtlasServer } from "./mod.ts";

const port = parseInt(Deno.env.get("ATLAS_PORT") ?? "8082");

startAtlasServer({ port });
