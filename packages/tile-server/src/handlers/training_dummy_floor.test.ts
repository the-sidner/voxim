/**
 * T-327: a TrainingDummy entity's Health is floored at 1, never 0, at the
 * damage-application site — the "never dies" guarantee has to live here
 * (not in a post-hoc skip of the death request) because DeathSystem's
 * composed-lethal sweep independently queries committed `Health.current <=
 * 0` every tick (death.ts). An ordinary entity is unaffected — a lethal hit
 * still lands it at exactly 0.
 */
import { assertEquals } from "jsr:@std/assert";
import { World, newEntityId, EventBus } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Health } from "../components/game.ts";
import { TrainingDummy } from "../components/training_dummy.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { HealthHitHandler } from "./health_hit_handler.ts";
import type { HitContext } from "../hit_handler.ts";

const content = await JsonSource.load();

function lethalHit(attackerId: EntityId, targetId: EntityId): HitContext {
  return {
    attackerId, targetId,
    weaponStats: { damage: 9999, weight: 1 },
    bodyPart: "torso_upper",
    attackerPart: "mid",
    targetSnapshotFacing: 0,
    attackerX: 2, attackerY: 0,
    targetX: 0, targetY: 0,
    hitX: 0, hitY: 0, hitZ: 0,
    parryAllowed: true,
    serverTick: 0,
  };
}

function newHandler(): HealthHitHandler {
  return new HealthHitHandler(content, { request: () => {} }, newModifierSourceRegistry());
}

Deno.test("a TrainingDummy's health floors at 1 on a lethal hit, never 0", () => {
  const world = new World();
  const target = newEntityId();
  world.create(target);
  world.write(target, Health, { current: 100, max: 100 });
  world.write(target, TrainingDummy, { healDelayTicks: 100, lastHitTick: 0, lastObservedHealth: 100 });
  const attacker = newEntityId();
  world.create(attacker);

  newHandler().onHit(world, new EventBus(), lethalHit(attacker, target));
  world.applyChangeset();

  assertEquals(world.get(target, Health)!.current, 1);
});

Deno.test("an ordinary entity (no TrainingDummy) still reaches exactly 0 on a lethal hit", () => {
  const world = new World();
  const target = newEntityId();
  world.create(target);
  world.write(target, Health, { current: 100, max: 100 });
  const attacker = newEntityId();
  world.create(attacker);

  newHandler().onHit(world, new EventBus(), lethalHit(attacker, target));
  world.applyChangeset();

  assertEquals(world.get(target, Health)!.current, 0);
});
