/**
 * Particle-source registry (T-340) — event → spawn-point mapping. Pure, headless.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { getParticleSource, registerBuiltinParticleSources } from "./particle_sources.ts";
import type { GameEvent } from "@voxim/protocol";

registerBuiltinParticleSources();

Deno.test("T-340: hit_impact source — HitSpark's own x/y/z, null on any other event", () => {
  const hitImpact = getParticleSource("hit_impact")!;
  const ev: GameEvent = {
    type: "HitSpark", x: 12.5, y: 44.25, z: 2, attackerPart: "tip", victimPart: "torso",
  };
  assertEquals(hitImpact(ev), { x: 12.5, y: 44.25, z: 2 });
  assertEquals(hitImpact({ type: "EntityDied", entityId: "e" }), null);
  assertEquals(
    hitImpact({ type: "DamageDealt", targetId: "t", sourceId: "s", amount: 5, blocked: false, hitX: 1, hitY: 2, hitZ: 3 }),
    null,
  );
});

Deno.test("T-340: unknown source id is undefined", () => {
  assert(getParticleSource("nope") === undefined);
});
