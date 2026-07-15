/**
 * ContentCache.isHydrated() is the gate renderer.ts's terrain bake path
 * (`_rebuildChunk`, T-331) checks before resolving any material id — a chunk
 * that bakes while this is false is exactly the silent-fallback-to-white bug
 * the gate exists to prevent. Pinned here since ContentCache itself needs no
 * DOM/THREE context, unlike the renderer that consumes it (verified live).
 */
import { assertEquals } from "jsr:@std/assert";
import { ContentCache } from "./content_cache.ts";

Deno.test("isHydrated is false before a bootstrap service is wired", () => {
  const cache = new ContentCache();
  assertEquals(cache.isHydrated(), false);
});

Deno.test("isHydrated is true once a bootstrap service is set", () => {
  const cache = new ContentCache();
  // deno-lint-ignore no-explicit-any
  cache.setBootstrapService({} as any);
  assertEquals(cache.isHydrated(), true);
});

Deno.test("isHydrated goes back to false if cleared to null", () => {
  const cache = new ContentCache();
  // deno-lint-ignore no-explicit-any
  cache.setBootstrapService({} as any);
  cache.setBootstrapService(null);
  assertEquals(cache.isHydrated(), false);
});
