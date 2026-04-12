/// <reference path="./types/webtransport.d.ts" />
/**
 * Plain HTTP server for gateway → tile internal messages and static client asset serving.
 * Runs on a separate port from WebTransport so TLS is not required.
 */
import { serveDir } from "@std/http/file-server";
import type { World } from "@voxim/engine";
import { restorePlayer } from "./handoff.ts";

export interface AdminServerDeps {
  world: World;
  /** Returns the current cert SHA-256 fingerprint (hex). Called per-request. */
  getCertHashHex: () => string;
  /** Returns the current WebTransport port. Called per-request. */
  getWtPort: () => number;
}

export function startAdminServer(port: number, deps: AdminServerDeps): void {
  Deno.serve(
    { port, hostname: "127.0.0.1" },
    (req) => handleAdminRequest(req, deps),
  );
  console.log(`[TileServer] admin HTTP listening on 127.0.0.1:${port}`);
}

async function handleAdminRequest(req: Request, deps: AdminServerDeps): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/handoff") {
    try {
      const payload = await req.json();
      if (!payload.playerId || !payload.components) {
        return new Response("bad request", { status: 400 });
      }
      restorePlayer(deps.world, payload);
      console.log(`[TileServer] received handoff for player ${payload.playerId}`);
      return Response.json({ type: "handoff_ack", playerId: payload.playerId });
    } catch {
      return new Response("bad request", { status: 400 });
    }
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok" });
  }

  if (req.method === "GET" && url.pathname === "/cert-hash") {
    return Response.json(
      { sha256: deps.getCertHashHex() },
      { headers: { "access-control-allow-origin": "*" } },
    );
  }

  if (req.method === "GET" && url.pathname === "/game") {
    return Response.redirect(
      `${url.origin}/?tile=${encodeURIComponent(url.hostname + ":" + deps.getWtPort())}`,
      302,
    );
  }

  // Serve all other client assets (index.html, dist/game.js, src/ui/theme.css, etc.)
  return serveDir(req, {
    fsRoot: new URL("../../client", import.meta.url).pathname,
    quiet: true,
  });
}

export function registerWithGateway(
  gatewayUrl: string,
  tileId: string,
  tileAddress: string,
  adminUrl: string,
): void {
  fetch(`${gatewayUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "register", tileId, address: tileAddress, adminUrl }),
  }).then((r) => {
    if (!r.ok) console.error(`[TileServer] gateway registration failed: ${r.status}`);
    else console.log(`[TileServer] registered with gateway as ${tileId} → ${tileAddress}`);
  }).catch((err: unknown) => {
    console.error("[TileServer] could not reach gateway:", err);
  });
}
