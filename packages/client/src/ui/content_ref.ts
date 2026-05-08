/**
 * Module-level handle to the ContentService hydrated from the WT-handshake
 * bootstrap blob (T-177 phase 3). UI components read content (item prefab
 * lookups, recipe matching, etc.) through this signal instead of importing
 * the now-deleted `*_static.ts` aggregations.
 *
 * Set once at game.start (after BootstrapSource.load), updated on tile
 * transition, cleared on game.stop.
 *
 * UI components must tolerate `value === null` — there's a small window
 * before the bootstrap arrives, and during a tile transition.
 */
import { signal } from "@preact/signals";
import type { ContentService } from "@voxim/content";

export const contentService = signal<ContentService | null>(null);

export function setContentService(service: ContentService | null): void {
  contentService.value = service;
}
