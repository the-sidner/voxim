/**
 * Game-client dev server.
 *
 * Bundles packages/client/src/main.ts → packages/client/dist/game.js with
 * esbuild's watch mode, and serves packages/client/ as a static root on
 * port 3000.
 *
 * Routes:
 *   /                  → packages/client/index.html
 *   /dist/game.js      → packages/client/dist/game.js (esbuild output)
 *   /src/**            → packages/client/src/** (raw theme.css etc.)
 *   /assets/**         → packages/client/assets/** if present
 *
 * Used by the docker compose `client-dev` service. Run locally with:
 *   deno run -A scripts/serve_client.ts
 *   deno task client-dev
 */

import * as esbuild from "npm:esbuild@0.25";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader@0.11";

const root = new URL("..", import.meta.url);
const clientRoot = new URL("packages/client/", root).pathname;
const port = parseInt(Deno.env.get("PORT") ?? "3000");

// ---- esbuild watch ----

// The deno-loader plugin types and esbuild's Plugin type are slightly
// out of sync; cast through unknown so the context() call type-checks.
// (build_client.ts uses esbuild.build() which has looser typing and avoids
// this.) Functionally identical.
const plugins = denoPlugins({
  configPath: new URL("deno.json", root).pathname,
}) as unknown as esbuild.Plugin[];

const ctx = await esbuild.context({
  plugins,
  entryPoints: [new URL("packages/client/src/main.ts", root).pathname],
  outfile: new URL("packages/client/dist/game.js", root).pathname,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: false,
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "info",
});

await ctx.rebuild();
await ctx.watch();
console.log("[client-dev] esbuild watching for changes");

// ---- static server ----

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".bin":  "application/octet-stream",
};

function ext(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i).toLowerCase() : "";
}

function safeJoin(base: string, rel: string): string | null {
  // Reject path traversal — only paths that stay under `base` are allowed.
  const joined = `${base}${rel}`;
  const normalized = new URL(`file://${joined}`).pathname;
  if (!normalized.startsWith(base)) return null;
  return normalized;
}

async function tryFile(path: string): Promise<Response | null> {
  try {
    const data = await Deno.readFile(path);
    return new Response(data, {
      headers: {
        "content-type": MIME[ext(path)] ?? "application/octet-stream",
        // Source files change every save — don't cache during dev.
        "cache-control": "no-store",
      },
    });
  } catch {
    return null;
  }
}

Deno.serve({ port }, async (req) => {
  const url = new URL(req.url);
  let pathname = url.pathname;

  if (pathname === "/") pathname = "/index.html";

  const resolved = safeJoin(clientRoot, pathname.slice(1));
  if (!resolved) return new Response("forbidden", { status: 403 });

  const res = await tryFile(resolved);
  if (res) return res;

  return new Response("not found", { status: 404 });
});

console.log(`[client-dev] http://localhost:${port}`);
