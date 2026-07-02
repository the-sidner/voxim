/**
 * Decal-source registry (T-311 P4) — event → spawn-spec mapping. Pure, headless.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { getDecalSource, registerBuiltinDecalSources } from "./decal_sources.ts";
import type { GameEvent } from "@voxim/protocol";

registerBuiltinDecalSources();
const noPos = () => null;

Deno.test("T-311 P4: damage source — hit point + amount-scaled intensity; blocked draws none", () => {
  const damage = getDecalSource("damage")!;
  const ev: GameEvent = {
    type: "DamageDealt", targetId: "t", sourceId: "s", amount: 15,
    blocked: false, hitX: 12.5, hitY: 44.25, hitZ: 2,
  };
  const spec = damage(ev, noPos)!;
  assertEquals(spec.x, 12.5);
  assertEquals(spec.y, 44.25);
  assertEquals(spec.intensity, 0.5);                       // 15 / 30
  assertEquals(damage({ ...ev, amount: 90 }, noPos)!.intensity, 1);  // clamps
  assertEquals(damage({ ...ev, blocked: true }, noPos), null);
  assertEquals(damage({ ...ev, amount: 0 }, noPos), null);
  // wrong event type → null
  assertEquals(damage({ type: "EntityDied", entityId: "e" }, noPos), null);
});

Deno.test("T-311 P4: death source — position from live state, null when out of AoI", () => {
  const death = getDecalSource("death")!;
  const ev: GameEvent = { type: "EntityDied", entityId: "e1", killerId: "k" };
  const spec = death(ev, (id) => id === "e1" ? { x: 3, y: 7 } : null)!;
  assertEquals(spec, { x: 3, y: 7, intensity: 1 });
  assertEquals(death(ev, noPos), null, "no position → no splat");
  assert(getDecalSource("nope") === undefined);
});
