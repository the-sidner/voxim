/**
 * Static dev server for devtools on port 8888.
 *
 * Routes:
 *   /            → packages/devtools/dist/voxel_editor.html
 *   /*.js        → packages/devtools/dist/
 *   /content/*   → packages/content/data/  (JSON game data)
 *
 * Run:
 *   deno run -A scripts/serve_devtools.ts
 *   deno task devtools   (after build)
 */

const root = new URL("..", import.meta.url);
const distDir = new URL("packages/devtools/dist/", root).pathname;
const contentDir = new URL("packages/content/data/", root).pathname;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".json": "application/json",
  ".css":  "text/css",
};

function ext(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i) : "";
}

async function serveFile(path: string): Promise<Response> {
  try {
    const data = await Deno.readFile(path);
    const mime = MIME[ext(path)] ?? "application/octet-stream";
    return new Response(data, { headers: { "Content-Type": mime } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

Deno.serve({ port: 8888 }, async (req) => {
  const url = new URL(req.url);
  let pathname = url.pathname;

  if (pathname === "/" || pathname === "/index.html") {
    return serveFile(`${distDir}voxel_editor.html`);
  }

  if (pathname.startsWith("/content/")) {
    const file = pathname.slice("/content/".length);
    return serveFile(`${contentDir}${file}`);
  }

  // Serve anything else from dist/
  return serveFile(`${distDir}${pathname.slice(1)}`);
});

console.log("[devtools] http://localhost:8888");
