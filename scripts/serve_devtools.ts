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

/**
 * If a request for e.g. "materials.json" 404s, check if "materials/" exists
 * as a subdirectory and aggregate all .json files in it into a JSON array.
 */
async function serveContentFile(contentDir: string, file: string): Promise<Response> {
  const directPath = `${contentDir}${file}`;
  try {
    const data = await Deno.readFile(directPath);
    return new Response(data, { headers: { "Content-Type": "application/json" } });
  } catch {
    // Fall through — check for per-item subdirectory.
  }

  if (file.endsWith(".json")) {
    const dirName = file.slice(0, -5); // strip ".json"
    const dirPath = `${contentDir}${dirName}`;
    try {
      const items: unknown[] = [];
      for await (const entry of Deno.readDir(dirPath)) {
        if (entry.isFile && entry.name.endsWith(".json")) {
          const text = await Deno.readTextFile(`${dirPath}/${entry.name}`);
          items.push(JSON.parse(text));
        }
      }
      items.sort((a, b) => {
        const ai = (a as Record<string, unknown>).id as string ?? "";
        const bi = (b as Record<string, unknown>).id as string ?? "";
        return ai < bi ? -1 : ai > bi ? 1 : 0;
      });
      return new Response(JSON.stringify(items), { headers: { "Content-Type": "application/json" } });
    } catch {
      // Directory also doesn't exist.
    }
  }

  return new Response("Not found", { status: 404 });
}

Deno.serve({ port: 8888 }, async (req) => {
  const url = new URL(req.url);
  let pathname = url.pathname;

  if (pathname === "/" || pathname === "/index.html") {
    return serveFile(`${distDir}voxel_editor.html`);
  }

  if (pathname.startsWith("/content/")) {
    const file = pathname.slice("/content/".length);
    return serveContentFile(contentDir, file);
  }

  // Serve anything else from dist/
  return serveFile(`${distDir}${pathname.slice(1)}`);
});

console.log("[devtools] http://localhost:8888");
