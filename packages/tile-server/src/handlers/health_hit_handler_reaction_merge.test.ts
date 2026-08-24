/**
 * PendingReaction priority merge (T-361 audit fix).
 *
 * Two attackers' swings can both be in their active phase in the same
 * dispatcher run, so HealthHitHandler.onHit fires twice against one entity
 * in one tick. PendingReaction writes were plain last-write-wins world.set
 * across those calls: a poise-break stagger (or a parry's punish stagger)
 * could be silently downgraded to a later light hit's flinch — the poise
 * reset still committed, so the punish was consumed with no stagger
 * delivered. The handler now merges same-tick requests per entity, keeping
 * the reaction with the higher ActionDef `interruptPriority`.
 */
import { assertEquals } from "jsr:@std/assert";
import { World, newEntityId, EventBus } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Health } from "../components/game.ts";
import { Resource } from "../components/resource.ts";
import { Blocking } from "../components/tags.ts";
import { ActiveActions, PendingReaction } from "../components/action.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { HealthHitHandler } from "./health_hit_handler.ts";
import type { HitContext } from "../hit_handler.ts";

const content = await JsonSource.load();

function newHandler(): HealthHitHandler {
  return new HealthHitHandler(content, { request: () => {} }, newModifierSourceRegistry());
}

/** A frontal, unblocked hit (attacker straight ahead of the target's facing). */
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

function spawnWithHealth(world: World): EntityId {
  const id = newEntityId();
  world.create(id);
  world.write(id, Health, { current: 100, max: 100 });
  return id;
}

Deno.test("a later same-tick light hit does not downgrade a poise-break stagger to a flinch", () => {
  const world = new World();
  const target = spawnWithHealth(world);
  // Poise low enough that the first heavy hit breaks it (overshoot below
  // the heavy tier → stagger_light), but the second light hit — reading
  // the same committed value — does not.
  world.write(target, Resource, { values: { poise: { value: 40, max: 50 } } });
  const a = newEntityId();
  world.create(a);
  const b = newEntityId();
  world.create(b);

  const handler = newHandler();
  handler.onHit(world, new EventBus(), frontalHit(a, target, 50, 7)); // breaks poise → stagger_light
  handler.onHit(world, new EventBus(), frontalHit(b, target, 15, 7)); // no break → hit_front
  world.applyChangeset();

  assertEquals(
    world.get(target, PendingReaction)?.actionId,
    "stagger_light",
    "the stagger (interruptPriority 50) survives the later flinch request (10)",
  );
});

Deno.test("a same-tick hit on a parried attacker does not erase the parry's punish stagger", () => {
  const world = new World();
  const parrier = spawnWithHealth(world);
  // Parry preconditions: blocking tag, stamina, and the block action held
  // inside the parry window.
  world.write(parrier, Resource, { values: { stamina: { value: 50, max: 100 } } });
  world.write(parrier, Blocking, {});
  world.write(parrier, ActiveActions, {
    states: { primary: { actionId: "block", phase: "hold", ticksInPhase: 2, initiator: "intent" } },
  });
  const attacker = spawnWithHealth(world);
  const third = newEntityId();
  world.create(third);

  const handler = newHandler();
  // Attacker swings into the parry (geometry inside the block arc: the
  // parrier faces toward the attacker, T-362) → stagger_heavy requested on
  // the ATTACKER. frontalHit()'s default geometry already places the
  // attacker in front of the target's facing, so no override is needed.
  handler.onHit(world, new EventBus(), frontalHit(attacker, parrier, 20, 3));
  // An unrelated hit lands on the attacker the same tick → hit_front
  // request, which must not replace the punish.
  handler.onHit(world, new EventBus(), frontalHit(third, attacker, 15, 3));
  world.applyChangeset();

  assertEquals(
    world.get(attacker, PendingReaction)?.actionId,
    "stagger_heavy",
    "the parry punish (interruptPriority 60) survives the unrelated flinch request",
  );
});

Deno.test("the merge is per-tick: a next-tick flinch is not outranked by last tick's consumed stagger", () => {
  const world = new World();
  const target = spawnWithHealth(world);
  world.write(target, Resource, { values: { poise: { value: 40, max: 50 } } });
  const a = newEntityId();
  world.create(a);

  const handler = newHandler();
  handler.onHit(world, new EventBus(), frontalHit(a, target, 50, 1)); // stagger_light
  world.applyChangeset();
  assertEquals(world.get(target, PendingReaction)?.actionId, "stagger_light");
  world.erase(target, PendingReaction); // the resolver's one-shot consume

  handler.onHit(world, new EventBus(), frontalHit(a, target, 15, 2)); // plain flinch next tick
  world.applyChangeset();
  assertEquals(
    world.get(target, PendingReaction)?.actionId,
    "hit_front",
    "a new tick starts a fresh merge — the stale stagger doesn't linger",
  );
});
