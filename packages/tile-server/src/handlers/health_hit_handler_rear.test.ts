/**
 * Rear partMultiplier (T-299) — a hit landing from behind the target's
 * facing deals `combat.partMultipliers.rearMultiplier`× more damage than an
 * identical hit from the front. Uses real content (game_config.json's
 * authored 1.4) via JsonSource.load, a bare World, and a stub EventEmitter —
 * no dispatcher/system stack needed since HealthHitHandler.onHit is a pure
 * request/response over world + events.
 */
import { assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { World, newEntityId, EventBus } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import { Health } from "../components/game.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { HealthHitHandler } from "./health_hit_handler.ts";
import type { HitContext } from "../hit_handler.ts";

const content = await JsonSource.load();

function spawnTarget(world: World): EntityId {
  const id = newEntityId();
  world.create(id);
  world.write(id, Health, { current: 100, max: 100 });
  return id;
}

/** A hit landing at `attackerAngle` radians around the target (0 = target's
 *  own forward direction, PI = directly behind). Target sits at the origin
 *  facing `targetFacing`; the attacker is placed so the geometry matches. */
function hitFrom(
  targetId: EntityId, attackerId: EntityId,
  targetFacing: number, attackerAngle: number,
): HitContext {
  const worldAngle = targetFacing + attackerAngle;
  const attackerX = Math.cos(worldAngle) * 2;
  const attackerY = Math.sin(worldAngle) * 2;
  return {
    attackerId, targetId,
    weaponStats: { damage: 20, weight: 1 },
    bodyPart: "torso_upper",
    attackerPart: "mid",
    targetSnapshotFacing: targetFacing,
    attackerX, attackerY,
    targetX: 0, targetY: 0,
    hitX: 0, hitY: 0, hitZ: 0,
    parryAllowed: true,
  };
}

function newHandler(): HealthHitHandler {
  return new HealthHitHandler(content, { request: () => {} }, newModifierSourceRegistry());
}

Deno.test("T-299: a hit from directly behind deals rearMultiplier× the damage of an identical hit from the front", () => {
  const rearMult = content.getGameConfig().combat.partMultipliers.rearMultiplier;
  assertEquals(rearMult > 1, true, "sanity: rearMultiplier is authored > 1 in game_config.json");

  const worldFront = new World();
  const targetFront = spawnTarget(worldFront);
  const attackerFront = newEntityId();
  worldFront.create(attackerFront);
  const eventsFront = new EventBus();
  let frontDamage = 0;
  eventsFront.subscribe(TileEvents.DamageDealt, (p: { amount: number }) => { frontDamage = p.amount; });
  newHandler().onHit(worldFront, eventsFront, hitFrom(targetFront, attackerFront, 0, 0));

  const worldBack = new World();
  const targetBack = spawnTarget(worldBack);
  const attackerBack = newEntityId();
  worldBack.create(attackerBack);
  const eventsBack = new EventBus();
  let backDamage = 0;
  eventsBack.subscribe(TileEvents.DamageDealt, (p: { amount: number }) => { backDamage = p.amount; });
  newHandler().onHit(worldBack, eventsBack, hitFrom(targetBack, attackerBack, 0, Math.PI));

  assertAlmostEquals(backDamage, frontDamage * rearMult, 1e-9);
});

Deno.test("T-299: a hit exactly on the flank (90°) counts as front (dot=0 is not '< 0')", () => {
  const world = new World();
  const target = spawnTarget(world);
  const attacker = newEntityId();
  world.create(attacker);
  const events = new EventBus();
  let damage = 0;
  events.subscribe(TileEvents.DamageDealt, (p: { amount: number }) => { damage = p.amount; });
  newHandler().onHit(world, events, hitFrom(target, attacker, 0, Math.PI / 2));

  // No rear multiplier at exactly 90°: base 20 damage, part multipliers 1.0×1.0.
  assertAlmostEquals(damage, 20, 1e-6);
});
