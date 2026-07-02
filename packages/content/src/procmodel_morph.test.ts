/**
 * Corruption-morph param merge (T-311 P4). Pure, headless.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { mergeMorphTierParams, morphTierParams } from "./procmodel_morph.ts";

Deno.test("T-311 P4: deep merge — nested objects merge, primitives/arrays replace", () => {
  const base = {
    trunk: { heightRange: [8, 12], material: "wood" },
    foliage: { radius: 2.3, density: 0.72, material: "grass" },
    droop: 0,
  };
  const merged = mergeMorphTierParams(base, {
    foliage: { density: 0.3, material: "mud" },
    droop: 1.2,
  });
  assertEquals(merged.foliage, { radius: 2.3, density: 0.3, material: "mud" });
  assertEquals(merged.trunk, base.trunk);
  assertEquals(merged.droop, 1.2);
  // non-mutating
  assertEquals(base.foliage.density, 0.72);
});

Deno.test("T-311 P4: morphTierParams — tier 0 = base; tiers select overrides; clamp", () => {
  const base = { blades: [5, 8], material: "moss" };
  const tiers = [{ material: "mud" }, { material: "corrupted", blades: [2, 3] }];
  assertEquals(morphTierParams(base, tiers, 0), base);
  assertEquals(morphTierParams(base, tiers, 1).material, "mud");
  assertEquals(morphTierParams(base, tiers, 2).blades, [2, 3]);
  // out-of-range clamps to the last authored tier
  assertEquals(morphTierParams(base, tiers, 9).material, "corrupted");
  // no tiers authored → base regardless
  assert(morphTierParams(base, undefined, 3) === base);
});
