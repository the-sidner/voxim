/**
 * T-303 — deriveItemStats' Composed `_parts` path.
 *
 * Integration test against real on-disk content (mirrors registry_smoke.test.ts):
 * proves that swapping a Composed sword's blade material measurably changes
 * the derived weight/damage via the live StatContribution schema, and that
 * a Composed prefab with no matching parts falls back to its hardcoded base
 * stats untouched (no regression for plain, non-Composed weapons).
 */
import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { JsonSource } from "./loader.ts";
import type { ItemPart } from "./types.ts";

Deno.test("Composed sword: swapping the blade material changes weight and damage", async () => {
  const content = await JsonSource.load();

  const base = content.deriveItemStats("composed_sword");
  // No parts supplied — base stats only (the hardcoded swingable.damage / weight).
  assertEquals(base.damage, 12);
  assertEquals(base.weight, 0.4);

  const ironParts: ItemPart[] = [
    { slot: "blade", materialName: "iron" },
    { slot: "grip", materialName: "oak" },
  ];
  const steelParts: ItemPart[] = [
    { slot: "blade", materialName: "steel" },
    { slot: "grip", materialName: "oak" },
  ];

  const iron = content.deriveItemStats("composed_sword", ironParts);
  const steel = content.deriveItemStats("composed_sword", steelParts);

  // iron: hardness 0.75, density 1 → damage 12 + 0.75*20 = 27, weight 0.4 + 1*0.8 + 0.45*0.3 = 1.335
  // steel: hardness 0.9, density 1.05 → damage 12 + 0.9*20 = 30, weight 0.4 + 1.05*0.8 + 0.45*0.3 = 1.375
  assertEquals(iron.damage, 27);
  assertEquals(steel.damage, 30);
  assertNotEquals(iron.damage, steel.damage);
  assertNotEquals(iron.weight, steel.weight);

  // Composed contributions ADD onto the hardcoded base — never replace it.
  if (iron.damage === undefined || base.damage === undefined) throw new Error("expected damage");
  if (iron.damage <= base.damage) throw new Error("composed blade should raise damage above the base");
});

Deno.test("Composed sword: a slot with no matching part is skipped, not thrown", async () => {
  const content = await JsonSource.load();
  // Only the blade slot filled — grip left unfilled.
  const stats = content.deriveItemStats("composed_sword", [
    { slot: "blade", materialName: "iron" },
  ]);
  assertEquals(stats.damage, 12 + 0.75 * 20);
});

Deno.test("Composed sword: an unknown material name is skipped, not thrown", async () => {
  const content = await JsonSource.load();
  const stats = content.deriveItemStats("composed_sword", [
    { slot: "blade", materialName: "unobtainium" },
  ]);
  assertEquals(stats.damage, 12);
});

Deno.test("Composed sword: attackRange is derived from the model AABB × modelScale", async () => {
  const content = await JsonSource.load();
  const stats = content.deriveItemStats("composed_sword");
  const aabb = content.getModelAabb("model_sword_basic")!;
  const expectedLen = Math.max(
    aabb.maxX - aabb.minX,
    aabb.maxY - aabb.minY,
    aabb.maxZ - aabb.minZ,
  ) * 0.1;
  assertEquals(stats.attackRange, expectedLen);
});

Deno.test("Plain (non-Composed) sword: iron_sword keeps its hardcoded damage — no regression", async () => {
  const content = await JsonSource.load();
  const stats = content.deriveItemStats("iron_sword");
  assertEquals(stats.damage, 25);
  assertEquals(stats.attackRange, undefined);
});
