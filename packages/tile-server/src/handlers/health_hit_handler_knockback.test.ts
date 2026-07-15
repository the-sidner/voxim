/**
 * Knockback impulses compose across same-tick hits (T-361 audit fix).
 *
 * The knockback branch read the COMMITTED Velocity and wrote back a whole
 * component with world.set — two attackers hitting the same target in one
 * tick both read the same base, and the second set overwrote the first:
 * one hit's entire impulse (including its z pop) vanished. Now a
 * world.mutate adds each impulse onto whatever earlier ops left behind
 * (T-249), so two simultaneous heavy hits shove like two.
 */
import { assertAlmostEquals } from "jsr:@std/assert";
import { World, newEntityId, EventBus } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Health, Velocity } from "../components/game.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { HealthHitHandler } from "./health_hit_handler.ts";
import type { HitContext } from "../hit_handler.ts";

const content = await JsonSource.load();

function frontalHit(
  attackerId: EntityId, targetId: EntityId, damage: number, serverTick: number,
): HitContext {
  return {
    attackerId, targetId,
    weaponStats: { damage, weight: 1 },
    bodyPart: "torso_upper",
    attackerPart: "mid",
    targetSnapshotFacing: 0,
    attackerX: 2, attackerY: 0,
    targetX: 0, targetY: 0,
    hitX: 0, hitY: 0, hitZ: 0,
    parryAllowed: true,
    serverTick,
  };
}

Deno.test("two same-tick hits both deliver their knockback impulse (impulses add, not last-write-wins)", () => {
  const world = new World();
  const target = newEntityId();
  world.create(target);
  world.write(target, Health, { current: 100, max: 100 });
  world.write(target, Velocity, { x: 0, y: 0, z: 0 });
  const a = newEntityId();
  world.create(a);
  const b = newEntityId();
  world.create(b);

  const combatCfg = content.getGameConfig().combat;
  const kb = combatCfg.knockback;
  const damage = 15;
  const mult = Math.max(kb.minMult, Math.min(kb.maxMult, damage / kb.referenceDamage));
  // Attacker at (+2, 0), target at origin → impulse direction (-1, 0).
  const oneKx = -combatCfg.knockbackImpulseXY * mult;
  const oneKz = combatCfg.knockbackImpulseZ * mult;

  const handler = new HealthHitHandler(content, { request: () => {} }, newModifierSourceRegistry());
  handler.onHit(world, new EventBus(), frontalHit(a, target, damage, 4));
  handler.onHit(world, new EventBus(), frontalHit(b, target, damage, 4));
  world.applyChangeset();

  const vel = world.get(target, Velocity)!;
  assertAlmostEquals(vel.x, 2 * oneKx, 1e-9, "both x impulses landed");
  assertAlmostEquals(vel.y, 0, 1e-9);
  assertAlmostEquals(vel.z, 2 * oneKz, 1e-9, "both z pops landed");
});
