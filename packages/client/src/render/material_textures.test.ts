/**
 * Texture-style registry + boot cross-check (T-311 Phase 0a, grammar G4). The
 * registry is map-only (no canvas), so it runs headless. Pins: built-in
 * registration is idempotent and covers the retired DRAW_FN set, the cross-check
 * resolves real content, and it fails fast on a typo'd `render.textureStyle` —
 * mirroring `crossCheckProcModels`.
 */
import { assert } from "jsr:@std/assert";
import { JsonSource } from "@voxim/content";
import {
  registerBuiltinTextureStyles,
  textureStyleIds,
  crossCheckTextureStyles,
} from "./material_textures.ts";

const content = await JsonSource.load("packages/content/data");

Deno.test("T-311: built-in texture styles register (idempotent) and cover the retired DRAW_FN set", () => {
  registerBuiltinTextureStyles();
  registerBuiltinTextureStyles(); // second call is a no-op, not a double-register throw
  for (const s of ["organic", "wood", "stone", "dirt", "sand", "metal", "leather", "bone"]) {
    assert(textureStyleIds().includes(s), `style "${s}" registered`);
  }
});

Deno.test("T-311: crossCheckTextureStyles passes on the real content", () => {
  crossCheckTextureStyles(content); // throws on a typo — reaching here is the pass
});

Deno.test("T-311: cross-check throws on an unknown textureStyle", () => {
  const bad = {
    materials: { values: () => [{ name: "broken", render: { textureStyle: "no_such_style" } }] },
  } as unknown as Parameters<typeof crossCheckTextureStyles>[0];
  let threw = false;
  try { crossCheckTextureStyles(bad); } catch { threw = true; }
  assert(threw, "unknown textureStyle id rejected");
});
