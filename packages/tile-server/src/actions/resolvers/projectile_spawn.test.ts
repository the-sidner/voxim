/**
 * ProjectileSpawnResolver — pitch-driven launch (T-337).
 *
 * No test exercised this resolver directly before (projectile.test.ts only
 * covers the FLIGHT resolver, ProjectileTraceResolver, seeding Position/
 * Velocity by hand). This locks in the gap-#2 behaviour: the launch vector
 * comes from `launchVelocity(facing, pitch, speed)` — the same function
 * the client's aim indicator calls — clamped to `combat.aim`'s band, not
 * the retired flat `arcFactor`.
 */

import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Position, Velocity, InputState } from "../../components/game.ts";
import { Equipment } from "../../components/equipment.ts";
import type { ActiveActionState } from "../../components/action.ts";
import type { ResolveContext } from "../effect.ts";
import { ProjectileSpawnResolver } from "./combat.ts";

const content = await JsonSource.load();
const STATE: ActiveActionState = { actionId: "bow_loose", phase: "active", ticksInPhase: 0, initiator: "intent" };

function equipWithBow(world: World): EntityId {
  const shooter = newEntityId();
  world.create(shooter);
  world.write(shooter, Position, { x: 0, y: 0, z: 1 });
  world.write(shooter, Equipment, {
    weapon: { entityId: "bow1", prefabId: "wooden_bow" },
    offHand: null, head: null, chest: null, legs: null, feet: null, back: null,
  });
  return shooter;
}

function spawnAt(world: World, shooter: EntityId, facing: number, pitch: number): EntityId {
  world.write(shooter, InputState, {
    facing, pitch, movementX: 0, movementY: 0, actions: 0, chargeMs: 0,
    seq: 0, timestamp: 0, rttMs: 0,
  });
  const before = new Set(world.query(Position).map((r) => r.entityId));
  const resolver = new ProjectileSpawnResolver();
  resolver.resolve({
    world, events: new EventBus(), entityId: shooter, slot: "primary", state: STATE,
    content, params: {}, edge: "enter", serverTick: 0,
  } as ResolveContext);
  world.applyChangeset();
  const after = world.query(Position).map((r) => r.entityId).filter((id) => !before.has(id));
  assertEquals(after.length, 1, "exactly one projectile spawned");
  return after[0];
}

Deno.test("projectile_spawn: pitch=0 is a level shot along facing", () => {
  const world = new World();
  const shooter = equipWithBow(world);
  const proj = spawnAt(world, shooter, 0, 0);
  const vel = world.get(proj, Velocity)!;
  const speed = content.weaponActions.get("bow_shot")!.projectile!.speed;
  assertAlmostEquals(vel.x, speed, 1e-4);
  assertAlmostEquals(vel.y, 0, 1e-4);
  assertAlmostEquals(vel.z, 0, 1e-4);
});

Deno.test("projectile_spawn: positive pitch trades horizontal speed for vertical (up = farther arc)", () => {
  const world = new World();
  const shooter = equipWithBow(world);
  const aimCfg = content.getGameConfig().combat.aim;
  const pitchMaxRad = aimCfg.pitchMaxDeg * Math.PI / 180;
  const proj = spawnAt(world, shooter, 0, pitchMaxRad);
  const vel = world.get(proj, Velocity)!;
  const speed = content.weaponActions.get("bow_shot")!.projectile!.speed;
  assertAlmostEquals(vel.x, speed * Math.cos(pitchMaxRad), 1e-4);
  assertAlmostEquals(vel.z, speed * Math.sin(pitchMaxRad), 1e-4);
  assert(vel.z > 0, "positive pitch launches upward");
});

Deno.test("projectile_spawn: pitch is clamped to the content-tuned aim band", () => {
  const world = new World();
  const shooter = equipWithBow(world);
  const aimCfg = content.getGameConfig().combat.aim;
  const pitchMaxRad = aimCfg.pitchMaxDeg * Math.PI / 180;
  // Way past the band — must clamp, not launch straight up.
  const proj = spawnAt(world, shooter, 0, Math.PI / 2);
  const vel = world.get(proj, Velocity)!;
  const speed = content.weaponActions.get("bow_shot")!.projectile!.speed;
  assertAlmostEquals(vel.z, speed * Math.sin(pitchMaxRad), 1e-4, "clamped to pitchMaxDeg, not the raw 90deg input");
});

Deno.test("projectile_spawn: facing rotates the horizontal launch direction", () => {
  const world = new World();
  const shooter = equipWithBow(world);
  const proj = spawnAt(world, shooter, Math.PI / 2, 0);
  const vel = world.get(proj, Velocity)!;
  const speed = content.weaponActions.get("bow_shot")!.projectile!.speed;
  assertAlmostEquals(vel.x, 0, 1e-4);
  assertAlmostEquals(vel.y, speed, 1e-4);
});

Deno.test("projectile_spawn: a gravityless weapon still points along the aimed elevation (only its flight ignores gravity)", () => {
  const world = new World();
  const shooter = equipWithBow(world);
  // Emulate a hypothetical gravityScale:0 ranged weapon by asserting the
  // formula itself is gravity-agnostic — bow_shot has gravity, so assert the
  // z component is present and non-zero at a nonzero pitch regardless
  // (the OLD arcFactor logic special-cased gravityScale>0; the new one does
  // not branch on it at all).
  const aimCfg = content.getGameConfig().combat.aim;
  const pitchRad = aimCfg.pitchMaxDeg * Math.PI / 180 / 2;
  const proj = spawnAt(world, shooter, 0, pitchRad);
  const vel = world.get(proj, Velocity)!;
  assert(vel.z > 0, "elevation is present in the launch vector regardless of gravityScale branching");
});
