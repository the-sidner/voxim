/**
 * REST helpers for the animation library editor.  All writes go through the
 * dev server's POST/DELETE handlers in `scripts/serve_devtools.ts`.
 */
import type { LibraryClipFile } from "@voxim/content";

const BASE = "/content";

/** Save a clip file to `data/anim_library/{id}.json`.  Throws on failure. */
export async function saveLibraryClip(clip: LibraryClipFile): Promise<void> {
  const res = await fetch(`${BASE}/anim_library/${clip.id}.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(clip, null, 2),
  });
  if (!res.ok) throw new Error(`save ${clip.id}: ${res.status} ${await res.text()}`);
}

/** Delete a library clip file. */
export async function deleteLibraryClip(id: string): Promise<void> {
  const res = await fetch(`${BASE}/anim_library/${id}.json`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete ${id}: ${res.status} ${await res.text()}`);
}

/** Save (full replace) a prefab file under `data/prefabs/...`. */
export async function savePrefab(relPath: string, body: unknown): Promise<void> {
  // relPath is e.g. "items/iron_sword.json" — full path under prefabs/
  const res = await fetch(`${BASE}/prefabs/${relPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, null, 2),
  });
  if (!res.ok) throw new Error(`save prefab ${relPath}: ${res.status} ${await res.text()}`);
}
