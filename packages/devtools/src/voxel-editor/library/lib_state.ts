/**
 * Animation library editor state — Preact signals.
 *
 * The library is the in-memory mirror of `packages/content/data/anim_library/`.
 * The devtool fetches it once at boot, then mutates locally and POSTs / DELETEs
 * individual files back to the dev server.  After a save the affected skeleton
 * is reloaded with the merged clips so the existing Animate tab sees the new
 * version on the next preview.
 */
import { signal } from "@preact/signals";
import type { LibraryClipFile } from "@voxim/content";

/** All files currently in the library, keyed by id (filename without .json). */
export const libraryClips = signal<LibraryClipFile[]>([]);

/** Which sub-workflow is open in the Library tab. */
export const librarySubTab = signal<"browse" | "import" | "mix" | "assign">("browse");

/** Currently selected clip id in the Browse panel, for inspection. */
export const selectedLibraryClipId = signal<string | null>(null);

/** Status / error banner shown at the top of the Library panel. */
export const libraryStatus = signal<{ kind: "ok" | "err" | "info"; text: string } | null>(null);

/** Sticky toast helper — clears after `ms`. */
export function flashStatus(kind: "ok" | "err" | "info", text: string, ms = 3500): void {
  libraryStatus.value = { kind, text };
  setTimeout(() => {
    if (libraryStatus.value?.text === text) libraryStatus.value = null;
  }, ms);
}
