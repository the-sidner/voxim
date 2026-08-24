/**
 * T-365 regression coverage: `_transitionToTile` re-hydrated ContentService
 * but never re-ran `renderer.setContentCache`, so grade/palette/canopy/
 * textureStyle/camera config leaked the previous tile's values across a
 * transition. `applyContentToRenderer` is the single call site both the
 * boot sequence and `_transitionToTile` now route through in game.ts — pin
 * its contract headlessly here (no THREE/WebGL canvas needed, unlike
 * VoximRenderer itself; live two-tile verification is the testplay.mjs
 * harness's job, not this suite's).
 */
import { assertEquals } from "jsr:@std/assert";
import { applyContentToRenderer, type ContentApplyTarget } from "./apply_content_to_renderer.ts";
import { ContentCache } from "./content_cache.ts";

function spyRenderer(): { target: ContentApplyTarget; calls: ContentCache[] } {
  const calls: ContentCache[] = [];
  return { target: { setContentCache: (c) => calls.push(c) }, calls };
}

Deno.test("applyContentToRenderer pushes the content cache into the renderer", () => {
  const { target, calls } = spyRenderer();
  const content = new ContentCache();
  applyContentToRenderer(target, content);
  assertEquals(calls, [content]);
});

Deno.test("applyContentToRenderer is a no-op when the renderer is not yet constructed", () => {
  const content = new ContentCache();
  // Must not throw — mirrors the optional-chained renderer on both the
  // boot and transition call sites in game.ts.
  applyContentToRenderer(null, content);
  applyContentToRenderer(undefined, content);
});

Deno.test("applyContentToRenderer is a no-op when content hasn't been constructed yet", () => {
  const { target, calls } = spyRenderer();
  applyContentToRenderer(target, null);
  applyContentToRenderer(target, undefined);
  assertEquals(calls, [], "renderer.setContentCache must never run without a content cache to give it");
});

Deno.test("applyContentToRenderer re-applies on every call — the tile-transition path calling it a second time must reach the renderer again, not be swallowed as a duplicate", () => {
  const { target, calls } = spyRenderer();
  const tileA = new ContentCache();
  const tileB = new ContentCache();
  applyContentToRenderer(target, tileA); // initial boot
  applyContentToRenderer(target, tileB); // tile transition (T-365)
  assertEquals(calls, [tileA, tileB]);
});
