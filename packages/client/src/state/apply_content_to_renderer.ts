/**
 * The ONE place `Game` pushes a (re-)hydrated `ContentCache` into the
 * renderer — called once at initial boot and again after every tile
 * transition (T-365). Before this ticket, `_transitionToTile` re-hydrated
 * the ContentCache (`content.setBootstrapService`) but never re-ran
 * `renderer.setContentCache`, so palette / grade / canopy+textureStyle
 * params / camera config all silently kept the PREVIOUS tile's values —
 * only the per-material texture cache was fixed at the time (90c91e5f).
 *
 * `VoximRenderer.setContentCache` is itself the renderer's single
 * content-apply entry point (it folds in the T-331 deferred-chunk rebuild +
 * texture-cache invalidation as its own final step, so that half can no
 * longer be called independently either). This wrapper is the matching
 * single call site on the `Game` side: both the boot sequence and
 * `_transitionToTile` route through it instead of each holding their own
 * copy of the "renderer or content might be null" guard, so the two paths
 * cannot drift apart again.
 *
 * Takes a minimal structural interface (not `VoximRenderer` itself) so this
 * stays import-light — safe to pull into a headless unit test without
 * dragging in three.js / a WebGL canvas, which `VoximRenderer` requires.
 */
import type { ContentCache } from "./content_cache.ts";

export interface ContentApplyTarget {
  setContentCache(cache: ContentCache): void;
}

export function applyContentToRenderer(
  renderer: ContentApplyTarget | null | undefined,
  content: ContentCache | null | undefined,
): void {
  if (!renderer || !content) return;
  renderer.setContentCache(content);
}
