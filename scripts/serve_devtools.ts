/**
 * Static dev server for devtools on port 8888.
 *
 * Routes:
 *   /                       → packages/devtools/dist/studio.html
 *   /*.js                   → packages/devtools/dist/
 *   /content/*              → packages/content/data/  (JSON game data — GET)
 *   POST /content/*         → write a JSON file under packages/content/data/
 *                             (only paths under anim_library/ are allowed; the
 *                             devtool needs to save imported clips to disk)
 *   DELETE /content/*       → delete a JSON file (anim_library/ only)
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
      // Recurse into nested directories — matches the server-side loader, so
      // `prefabs.json` aggregates both `prefabs/*.json` AND `prefabs/items/*.json`
      // (and any deeper buckets a future refactor introduces).  Without this
      // the Assign panel would only see top-level prefabs.
      await collectAllJson(dirPath, items);
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

async function collectAllJson(dir: string, out: unknown[]): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      await collectAllJson(full, out);
    } else if (entry.isFile && entry.name.endsWith(".json")) {
      const text = await Deno.readTextFile(full);
      out.push(JSON.parse(text));
    }
  }
}

/**
 * Whitelist of subdirectories the devtool may write into.
 * - anim_library/    — imported / mixed animation clips and compound recipes
 * - prefabs/         — Assign workflow rewrites a prefab's animationSlots
 *                      field; full file replacement so don't hand-edit a
 *                      prefab while the devtool has it loaded
 * - models/          — new studio voxel editor authors ModelDefinition JSON
 * - clip_overrides/  — new studio animation editor stores per-clip
 *                      attachment-override JSON (T-191e)
 * - generators/      — generator declarations (T-183) authored in the
 *                      voxel editor when spawning procedural sub-objects
 * - skeletons/       — skeleton bone/mask tweaks from the animation editor
 */
const WRITABLE_PREFIXES = [
  "anim_library/",
  "prefabs/",
  "models/",
  "clip_overrides/",
  "generators/",
  "skeletons/",
  "materials/",   // T-311 Phase 1b — the Studio Material editor writes render blocks
  "procmodels/",  // T-311 Phase 1a — the Studio ProcModel editor writes tuned params
];

function isWritablePath(file: string): boolean {
  // Reject any traversal; require the path to be inside one of WRITABLE_PREFIXES.
  if (file.includes("..") || file.startsWith("/")) return false;
  if (!file.endsWith(".json")) return false;
  return WRITABLE_PREFIXES.some((p) => file.startsWith(p));
}

Deno.serve({ port: 8888 }, async (req) => {
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (req.method === "POST" && pathname.startsWith("/content/")) {
    const file = pathname.slice("/content/".length);
    if (!isWritablePath(file)) {
      return new Response(`Path not writable: ${file}`, { status: 403 });
    }
    try {
      const body = await req.text();
      // Validate JSON before writing — prevents partial corruption.
      JSON.parse(body);
      const target = `${contentDir}${file}`;
      const dir = target.slice(0, target.lastIndexOf("/"));
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(target, body);
      return new Response(JSON.stringify({ ok: true, path: file }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(`Write failed: ${(err as Error).message}`, { status: 400 });
    }
  }

  if (req.method === "DELETE" && pathname.startsWith("/content/")) {
    const file = pathname.slice("/content/".length);
    if (!isWritablePath(file)) {
      return new Response(`Path not deletable: ${file}`, { status: 403 });
    }
    try {
      await Deno.remove(`${contentDir}${file}`);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(`Delete failed: ${(err as Error).message}`, { status: 400 });
    }
  }

  // Directory listing for the studio asset browser. Returns the immediate
  // children of `data/<dir>` as `{ name, kind: "file" | "directory" }` so
  // the tree UI can walk lazily without aggregating large JSON arrays.
  if (req.method === "GET" && pathname.startsWith("/content-list/")) {
    const sub = pathname.slice("/content-list/".length);
    if (sub.includes("..") || sub.startsWith("/")) {
      return new Response("bad path", { status: 400 });
    }
    const dir = sub === "" ? contentDir : `${contentDir}${sub}`;
    try {
      const entries: { name: string; kind: "file" | "directory" }[] = [];
      for await (const e of Deno.readDir(dir)) {
        if (e.isFile && !e.name.endsWith(".json")) continue;
        entries.push({
          name: e.name,
          kind: e.isDirectory ? "directory" : "file",
        });
      }
      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
      return new Response(JSON.stringify(entries), {
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      return new Response("[]", { headers: { "Content-Type": "application/json" } });
    }
  }

  // Studio (T-191) is the only devtools shell now — the old voxel-editor was
  // retired (T-191z). `/` and `/studio` both serve it.
  if (
    pathname === "/" || pathname === "/index.html" ||
    pathname === "/studio" || pathname === "/studio/" || pathname === "/studio.html"
  ) {
    return serveFile(`${distDir}studio.html`);
  }

  if (pathname.startsWith("/content/")) {
    const file = pathname.slice("/content/".length);
    return serveContentFile(contentDir, file);
  }

  // Serve anything else from dist/
  return serveFile(`${distDir}${pathname.slice(1)}`);
});

console.log("[devtools] http://localhost:8888");
