/**
 * Block arc geometry (T-362) — HealthHitHandler.onHit's `isBlocking` gate
 * must register a block when the target is FACING TOWARD the attacker (the
 * front-arc idiom shared with `frontBackDot` twenty lines below it and with
 * check_target_flanking.ts's defender-side check: "am I about to be
 * flanked" reads the same dot product from the defender's forward axis).
 *
 * `incomingAngle` used to measure the attacker→target travel direction
 * against the target's facing — the opposite convention — so a target
 * turned AWAY from its attacker blocked, and a target facing its attacker
 * head-on took full damage. Fixed to compare the target→attacker direction
 * instead (same vector `frontBackDot` builds as `targetToAttacker`).
 */
import { assertEquals } from "jsr:@std/assert";
import { World, newEntityId, EventBus } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import { Health } from "../components/game.ts";
import { Resource } from "../components/resource.ts";
import { Blocking } from "../components/tags.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { HealthHitHandler } from "./health_hit_handler.ts";
import type { HitContext } from "../hit_handler.ts";

const content = await JsonSource.load();

function spawnBlockingTarget(world: World): EntityId {
  const id = newEntityId();
  world.create(id);
  world.write(id, Health, { current: 100, max: 100 });
  // Stamina > 0 so `stamGated` doesn't mask the geometry under test, and no
  // ActiveActions primary so blockHeldTicks falls back to
  // Number.MAX_SAFE_INTEGER — never < parryWindowTicks, so every case here
  // takes the plain block-multiplier path, not the parry short-circuit.
  world.write(id, Resource, { values: { stamina: { value: 50, max: 100 } } });
  world.write(id, Blocking, {});
  return id;
}

/** A hit landing at `attackerAngle` radians off the target's own forward
 *  direction (0 = dead ahead / facing the attacker, PI = directly behind).
 *  Target sits at the origin facing `targetFacing`; the attacker is placed
 *  so the geometry matches. Same idiom as
 *  health_hit_handler_rear.test.ts's hitFrom(). */
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
    serverTick: 0,
  };
}

function newHandler(): HealthHitHandler {
  return new HealthHitHandler(content, { request: () => {} }, newModifierSourceRegistry());
}

/** Runs the hit and returns the `blocked` flag off the published
 *  DamageDealt event — the same flag isBlocking drives for both the damage
 *  multiplier and the hit-reaction gate. */
function damageDealtBlocked(world: World, ctx: HitContext): boolean {
  const events = new EventBus();
  let blocked = false;
  events.subscribe(TileEvents.DamageDealt, (p: { blocked: boolean }) => { blocked = p.blocked; });
  newHandler().onHit(world, events, ctx);
  return blocked;
}

Deno.test("T-362: a hit from the front registers as blocked while the target holds block", () => {
  const world = new World();
  const target = spawnBlockingTarget(world);
  const attacker = newEntityId();
  world.create(attacker);

  const blocked = damageDealtBlocked(world, hitFrom(target, attacker, 0, 0));
  assertEquals(blocked, true, "a target facing its attacker blocks a frontal hit");
});

Deno.test("T-362: a hit from directly behind is not blocked even while the target holds block", () => {
  const world = new World();
  const target = spawnBlockingTarget(world);
  const attacker = newEntityId();
  world.create(attacker);

  const blocked = damageDealtBlocked(world, hitFrom(target, attacker, 0, Math.PI));
  assertEquals(blocked, false, "block only covers the target's front arc, not its back");
});

Deno.test("T-362: the block arc edge is inclusive (<=), just outside it is not", () => {
  const halfArc = content.getGameConfig().combat.blockArcHalfRadians;

  const worldAtEdge = new World();
  const targetAtEdge = spawnBlockingTarget(worldAtEdge);
  const attackerAtEdge = newEntityId();
  worldAtEdge.create(attackerAtEdge);
  assertEquals(
    damageDealtBlocked(worldAtEdge, hitFrom(targetAtEdge, attackerAtEdge, 0, halfArc)),
    true,
    "exactly at blockArcHalfRadians still blocks",
  );

  const worldPastEdge = new World();
  const targetPastEdge = spawnBlockingTarget(worldPastEdge);
  const attackerPastEdge = newEntityId();
  worldPastEdge.create(attackerPastEdge);
  assertEquals(
    damageDealtBlocked(worldPastEdge, hitFrom(targetPastEdge, attackerPastEdge, 0, halfArc + 0.01)),
    false,
    "just past blockArcHalfRadians no longer blocks",
  );
});
