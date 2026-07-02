/**
 * Decal-source registry (T-311 P4) — event → spawn-spec mapping. Pure, headless.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { getDecalSource, registerBuiltinDecalSources } from "./decal_sources.ts";
import type { GameEvent } from "@voxim/protocol";
import type { DecalDef } from "@voxim/content";

registerBuiltinDecalSources();
const noPos = () => null;
const mockDamageDef: DecalDef = {
  id: "blood_splatter", source: "damage", material: "blood",
  count: [2, 5], radius: 0.8, sizeRange: [0.22, 0.5], ttlSeconds: 75, fadeSeconds: 45,
};
const mockDeathDef: DecalDef = {
  id: "blood_pool", source: "death", material: "blood",
  count: [5, 9], radius: 1.1, sizeRange: [0.35, 0.8], ttlSeconds: 150, fadeSeconds: 60,
};

Deno.test("T-311 P4: damage source — hit point + amount-scaled intensity; blocked draws none", () => {
  const damage = getDecalSource("damage")!;
  const ev: GameEvent = {
    type: "DamageDealt", targetId: "t", sourceId: "s", amount: 15,
    blocked: false, hitX: 12.5, hitY: 44.25, hitZ: 2,
  };
  const spec = damage(ev, noPos, mockDamageDef)!;
  assertEquals(spec.x, 12.5);
  assertEquals(spec.y, 44.25);
  assertEquals(spec.intensity, 0.5);                       // 15 / 30 (default fullIntensityAt)
  assertEquals(damage({ ...ev, amount: 90 }, noPos, mockDamageDef)!.intensity, 1);  // clamps
  assertEquals(damage({ ...ev, blocked: true }, noPos, mockDamageDef), null);
  assertEquals(damage({ ...ev, amount: 0 }, noPos, mockDamageDef), null);
  // wrong event type → null
  assertEquals(damage({ type: "EntityDied", entityId: "e" }, noPos, mockDamageDef), null);
  // authored fullIntensityAt overrides the default
  const customDef = { ...mockDamageDef, fullIntensityAt: 15 };
  assertEquals(damage(ev, noPos, customDef)!.intensity, 1);
});

Deno.test("T-311 P4: death source — position from live state, null when out of AoI", () => {
  const death = getDecalSource("death")!;
  const ev: GameEvent = { type: "EntityDied", entityId: "e1", killerId: "k" };
  const spec = death(ev, (id) => id === "e1" ? { x: 3, y: 7 } : null, mockDeathDef)!;
  assertEquals(spec, { x: 3, y: 7, intensity: 1 });
  assertEquals(death(ev, noPos, mockDeathDef), null, "no position → no splat");
  assert(getDecalSource("nope") === undefined);
});
