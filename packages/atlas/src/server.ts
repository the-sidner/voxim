/// <reference lib="deno.ns" />
/**
 * Atlas HTTP server.
 *
 * Phase 0: only /health is wired. Subsequent phases add /world/*, /tile/*,
 * and the inspector UI.
 */

export interface AtlasServerConfig {
  port: number;
}

export function startAtlasServer(cfg: AtlasServerConfig): void {
  Deno.serve(
    { port: cfg.port, hostname: "0.0.0.0" },
    handleRequest,
  );
  console.log(`[Atlas] listening on 0.0.0.0:${cfg.port}`);
}

function handleRequest(req: Request): Response {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json(
      { status: "ok", service: "atlas", phase: 0 },
      { headers: { "access-control-allow-origin": "*" } },
    );
  }

  return new Response("not found", { status: 404 });
}
