/**
 * Devtools file IO over HTTP to scripts/serve_devtools.ts.
 *
 * The dev server bind-mounts packages/content/data/ as its content root.
 * All paths in this module are relative to that root — passing
 * "models/sword.json" reads/writes the file at
 * packages/content/data/models/sword.json on the host filesystem.
 *
 * The server applies a writable-prefix whitelist (see serve_devtools.ts);
 * attempts to write outside it return 403. Reads are not restricted.
 *
 * No game-content imports — pure file IO. The studio uses this for both
 * the asset browser tree and the editors' save paths.
 */

export interface DirEntry {
  name: string;
  kind: "file" | "directory";
}

/** List the immediate children of a content subdirectory. */
export async function listDir(path: string): Promise<DirEntry[]> {
  const clean = path.replace(/^\/+/, "").replace(/\/+$/, "");
  const res = await fetch(`/content-list/${clean}`);
  if (!res.ok) throw new Error(`listDir ${clean}: ${res.status}`);
  return res.json() as Promise<DirEntry[]>;
}

/** Read a JSON file. Throws if missing or unparseable. */
export async function readJson<T = unknown>(path: string): Promise<T> {
  const clean = path.replace(/^\/+/, "");
  const res = await fetch(`/content/${clean}`);
  if (!res.ok) throw new Error(`readJson ${clean}: ${res.status}`);
  return res.json() as Promise<T>;
}

/** Write a JSON file. Server validates and rejects malformed JSON. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  const clean = path.replace(/^\/+/, "");
  const res = await fetch(`/content/${clean}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value, null, 2),
  });
  if (!res.ok) throw new Error(`writeJson ${clean}: ${res.status} ${await res.text()}`);
}

/** Delete a file. Server enforces same writable-prefix whitelist. */
export async function deleteFile(path: string): Promise<void> {
  const clean = path.replace(/^\/+/, "");
  const res = await fetch(`/content/${clean}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteFile ${clean}: ${res.status}`);
}

/** Read a JSON file as a string (for the inspector / text fallback). */
export async function readText(path: string): Promise<string> {
  const clean = path.replace(/^\/+/, "");
  const res = await fetch(`/content/${clean}`);
  if (!res.ok) throw new Error(`readText ${clean}: ${res.status}`);
  return res.text();
}
