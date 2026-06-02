/**
 * projectile_flight integration (T-243).
 *
 * Real content + real dispatcher exercising a projectile as a substrate
 * citizen: an entity carrying the `projectile_flight` ambient action whose
 * perpetual `hold:tick` fires `projectile_trace` — ballistic motion,
 * entity collision over the shared HitHandler chain, and destruction on
 * maxHits. No ActorSlots, no intent (the dispatcher just advances the
 * ambient action — the buff-child precedent). Replaces ProjectileSystem.
 *
 * Warmup note: the dispatcher fires `:tick` only once `ticksInPhase > 0`,
 * so the first dispatched tick after spawn is a no-op (same one-tick warmup
 * a buff child gets). Motion begins on the second dispatched tick.
 */

import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { ActiveActions } from "../components/action.ts";
import { Position, Velocity } from "../components/game.ts";
import { Hitbox } from "../components/hitbox.ts";
import { ProjectileData } from "../components/projectile.ts";
import { ActionDispatcher } from "./dispatcher.ts";
import { newGateRegistry } from "./gate.ts";
import { newEffectRegistry } from "./effect.ts";
import { ProjectileTraceResolver } from "./resolvers/projectile.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";

const content = await JsonSource.load();
const TICK_DT = 1 / 20;

function wiredDispatcher(handlers: HitHandler[]): ActionDispatcher {
  const gates = newGateRegistry();
  const effects = newEffectRegistry();
  effects.register(new ProjectileTraceResolver(handlers));
  // No intent / cost handler: a projectile has no ActorSlots, so the
  // dispatcher only advances its already-seeded ambient action.
  return new ActionDispatcher(content, gates, effects);
}

function spawnProjectile(
  world: World,
  opts: { pos?: { x: number; y: number; z: number }; vel?: { x: number; y: number; z: number }; gravityScale?: number; maxHits?: number; ownerId?: string },
): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, opts.pos ?? { x: 0, y: 0, z: 1 });
  world.write(id, Velocity, opts.vel ?? { x: 10, y: 0, z: 0 });
  world.write(id, ProjectileData, {
    ownerId: opts.ownerId ?? "owner",
    damage: 5, toolType: "", harvestPower: 1, buildPower: 0, armorReduction: 0,
    gravityScale: opts.gravityScale ?? 0, radius: 0.1, hitEntities: [], maxHits: opts.maxHits ?? 1,
  });
  world.write(id, ActiveActions, {
    states: { flight: { actionId: "projectile_flight", phase: "hold", ticksInPhase: 0, initiator: "ambient" } },
  });
  return id;
}

function tick(world: World, d: ActionDispatcher, serverTick: number): void {
  d.prepare(serverTick);
  d.run(world, new EventBus(), TICK_DT);
  world.applyChangeset();
}

Deno.test("projectile_flight: ambient action integrates ballistic motion", () => {
  const world = new World();
  const id = spawnProjectile(world, { vel: { x: 10, y: 0, z: 0 }, gravityScale: 0 });
  const d = wiredDispatcher([]);

  // Tick 0: warmup (ticksInPhase 0 → no :tick), no motion yet.
  tick(world, d, 0);
  assertEquals(world.get(id, Position)!.x, 0, "no motion on the warmup tick");

  // Ticks 1 & 2 fire projectile_trace → two motion steps of 10 × 1/20.
  tick(world, d, 1);
  tick(world, d, 2);
  assertAlmostEquals(world.get(id, Position)!.x, 1.0, 1e-6, "two ballistic steps of 0.5");
  assert(world.isAlive(id), "still flying — no terrain or entity hit");
});

Deno.test("projectile_flight: gravity bends the arc downward", () => {
  const world = new World();
  const id = spawnProjectile(world, { pos: { x: 0, y: 0, z: 50 }, vel: { x: 10, y: 0, z: 0 }, gravityScale: 1 });
  const d = wiredDispatcher([]);
  const g = content.getGameConfig().physics.gravity;

  tick(world, d, 0); // warmup
  tick(world, d, 1); // one motion step
  // ballisticStep applies velocity first, then decrements vz — first step
  // moves z by the (still-zero) vz, so z is unchanged but vz is now negative.
  assertEquals(world.get(id, Velocity)!.z, -g * TICK_DT, "gravity charged vz");
  tick(world, d, 2);
  assert(world.get(id, Position)!.z < 50, "arc now descending");
});

Deno.test("projectile_flight: entity hit dispatches to handler chain + destroys at maxHits", () => {
  const world = new World();
  const hits: HitContext[] = [];
  const recorder: HitHandler = { onHit: (_w, _e, ctx) => { hits.push(ctx); } };
  const d = wiredDispatcher([recorder]);

  // Target with a unit-sphere hitbox at (1,0,1) — the projectile's path
  // (0,0,1) → (0.5,0,1) passes within the combined radius on its first
  // motion tick.
  const target = newEntityId();
  world.create(target);
  world.write(target, Position, { x: 1, y: 0, z: 1 });
  world.write(target, Hitbox, {
    derive: false,
    parts: [{ id: "core", fromFwd: 0, fromRight: 0, fromUp: 0, toFwd: 0, toRight: 0, toUp: 0, radius: 1.0 }],
  });

  const proj = spawnProjectile(world, { pos: { x: 0, y: 0, z: 1 }, vel: { x: 10, y: 0, z: 0 }, gravityScale: 0, maxHits: 1, ownerId: "shooter" });

  tick(world, d, 0); // warmup, no hit
  assertEquals(hits.length, 0);
  tick(world, d, 1); // motion + collision

  assertEquals(hits.length, 1, "one hit dispatched");
  assertEquals(hits[0].targetId, target);
  assertEquals(hits[0].attackerId, "shooter");
  assertEquals(hits[0].attackerPart, "tip", "projectiles strike with their point");
  assertEquals(hits[0].parryAllowed, false, "no parry against ranged");
  assert(!world.isAlive(proj), "projectile destroyed at maxHits");
});

Deno.test("projectile_flight: never hits its owner", () => {
  const world = new World();
  const hits: HitContext[] = [];
  const d = wiredDispatcher([{ onHit: (_w, _e, ctx) => { hits.push(ctx); } }]);

  const owner = newEntityId();
  world.create(owner);
  world.write(owner, Position, { x: 1, y: 0, z: 1 });
  world.write(owner, Hitbox, {
    derive: false,
    parts: [{ id: "core", fromFwd: 0, fromRight: 0, fromUp: 0, toFwd: 0, toRight: 0, toUp: 0, radius: 1.0 }],
  });

  const proj = spawnProjectile(world, { pos: { x: 0, y: 0, z: 1 }, vel: { x: 10, y: 0, z: 0 }, gravityScale: 0, ownerId: owner });
  tick(world, d, 0);
  tick(world, d, 1);
  assertEquals(hits.length, 0, "owner is excluded from the broad-phase");
  assert(world.isAlive(proj), "passes through the shooter");
});
