/**
 * Material state-ladder resolution (T-311 Phase 2, G3). Pure, headless.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { resolveMaterialVariant, materialVariantIndex } from "./material_variant.ts";
import type { MaterialDef } from "./types.ts";

function base(): MaterialDef {
  return {
    id: 3, name: "stone", color: 0x808080, roughness: 0.8, metallic: 0, emissive: 0,
    solid: true, walkable: true,
    properties: { hardness: 0.5, density: 0.8, flexibility: 0.05, flammability: 0, toughness: 0.6 },
    tags: ["stone"],
    variants: [
      { id: "corrupted", colorShift: { h: 0.0, s: 0.3, l: -0.25 }, emissiveCracks: 0.3, addsTags: ["corrupted"] },
      { id: "mossy", colorOverride: 0x4a5a2a },
    ],
  };
}

Deno.test("T-311: no/out-of-range variant → base def unchanged", () => {
  const d = base();
  assertEquals(resolveMaterialVariant(d, -1), d);
  assertEquals(resolveMaterialVariant(d, 99), d);
  assertEquals(resolveMaterialVariant({ ...d, variants: undefined }, 0).color, d.color);
});

Deno.test("T-311: colorOverride wins; emissiveCracks + addsTags apply", () => {
  const moss = resolveMaterialVariant(base(), 1); // mossy = colorOverride
  assertEquals(moss.color, 0x4a5a2a);
  assertEquals(moss.emissive, 0); // no emissiveCracks on mossy

  const cor = resolveMaterialVariant(base(), 0); // corrupted = colorShift + emissive + tag
  assert(cor.color !== 0x808080, "colorShift changed the colour");
  assertEquals(cor.emissive, 0.3, "emissiveCracks → emissive");
  assert(cor.tags?.includes("corrupted") && cor.tags?.includes("stone"), "addsTags appended to base tags");
});

Deno.test("T-311: colorShift toward dark lowers luminance", () => {
  const cor = resolveMaterialVariant(base(), 0);
  const lum = (c: number) => ((c >> 16 & 0xff) + (c >> 8 & 0xff) + (c & 0xff)) / 3;
  assert(lum(cor.color) < lum(0x808080), `darker (${lum(cor.color)} < ${lum(0x808080)})`);
});

Deno.test("T-311: materialVariantIndex maps stable id → array position", () => {
  assertEquals(materialVariantIndex(base(), "corrupted"), 0);
  assertEquals(materialVariantIndex(base(), "mossy"), 1);
  assertEquals(materialVariantIndex(base(), "nope"), -1);
});
