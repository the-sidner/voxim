/**
 * PhysicsSystem × sparse delta channel (T-361).
 *
 * Every entry in the applied changeset becomes a wire delta (buildDeltaMap
 * consumes changeset.sets and applyChangeset has no value-equality gate), so
 * PhysicsSystem must not commit Position/Velocity/Facing when the integration
 * produced identical values. Before the gate landed, an idle actor produced 3
 * delta entries per tick (Position + Velocity + Facing — a 20 Hz rebroadcast
 * of every stationary NPC on the tile); after it, 0.
 */
import { assertEquals } from "jsr:@std/assert";
import { EventBus, World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import type { ChangesetSet } from "@voxim/engine";
import { Position, Velocity, Facing, InputState } from "../components/game.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { PhysicsSystem } from "./physics.ts";

const content = await JsonSource.load();

function spawnActor(world: World, movementX: number): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x: 10, y: 10, z: 0 });
  world.write(id, Velocity, { x: 0, y: 0, z: 0 });
  world.write(id, Facing, { angle: 0 });
  world.write(id, InputState, {
    seq: 0, timestamp: 0, facing: 0, pitch: 0, movementX, movementY: 0,
    actions: 0, rttMs: 0, chargeMs: 0,
  });
  return id;
}

/** Networked physics-state sets for one entity in an applied changeset. */
function physicsSets(sets: ReadonlyArray<ChangesetSet>, entityId: string) {
  const physicsTokens = new Set<unknown>([Position, Velocity, Facing]);
  return sets.filter((s) =>
    s.entityId === entityId && s.token.networked && physicsTokens.has(s.token)
  );
}

Deno.test("PhysicsSystem: an idle actor produces zero Position/Velocity/Facing delta entries", () => {
  const world = new World();
  const events = new EventBus();
  const sys = new PhysicsSystem(content, newModifierSourceRegistry());

  const idler = spawnActor(world, 0);
  world.applyChangeset();

  // Settle once (spawn state is already a rest fixpoint, but don't rely on it).
  sys.prepare(1);
  sys.run(world, events, 1 / 20);
  world.applyChangeset();

  // The tick under test: a resting actor must contribute NOTHING to the
  // delta channel.
  sys.prepare(2);
  sys.run(world, events, 1 / 20);
  const changeset = world.applyChangeset();

  assertEquals(
    physicsSets(changeset.sets, idler).length,
    0,
    "idle actor must not re-ship unchanged Position/Velocity/Facing",
  );
});

Deno.test("PhysicsSystem: a moving actor still commits changed Position/Velocity", () => {
  const world = new World();
  const events = new EventBus();
  const sys = new PhysicsSystem(content, newModifierSourceRegistry());

  const mover = spawnActor(world, 1);
  world.applyChangeset();

  sys.prepare(1);
  sys.run(world, events, 1 / 20);
  const changeset = world.applyChangeset();

  const tokens = physicsSets(changeset.sets, mover).map((s) => s.token.name).sort();
  // Facing is unchanged (input facing 0 == spawn angle 0) — sparse means it
  // is absent even for a moving actor.
  assertEquals(tokens, ["position", "velocity"]);

  const pos = world.get(mover, Position)!;
  assertEquals(pos.x > 10, true, "movement still integrates");
});
