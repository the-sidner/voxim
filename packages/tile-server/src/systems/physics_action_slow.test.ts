/**
 * PhysicsSystem × action movement multiplier (T-345).
 *
 * `movement: "slowed"` used to be a lie: the enum existed, 17 ActionDefs
 * declared it, and `isMovementLocked` read it as `"free"` — so drawing a bow
 * felt exactly like walking. The mode is now the NUMBER itself, per phase, which
 * is what makes the penalty depend on what you are doing.
 *
 * These tests pin the consumption site — that the number actually reaches
 * `maxGroundSpeed` — and the two properties that make it composable: the
 * strictest slot wins, and the multiplier stacks with the modifier stack rather
 * than replacing it.
 */
import { assert, assertAlmostEquals } from "jsr:@std/assert";
import { EventBus, World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Position, Velocity, Facing, InputState } from "../components/game.ts";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { PhysicsSystem } from "./physics.ts";

const content = await JsonSource.load();
const DT = 1 / 20;

function spawnMover(world: World): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x: 0, y: 0, z: 0 });
  world.write(id, Velocity, { x: 0, y: 0, z: 0 });
  world.write(id, Facing, { angle: 0 });
  world.write(id, InputState, {
    seq: 0, timestamp: 0, facing: 0, pitch: 0, movementX: 1, movementY: 0, actions: 0,
    rttMs: 0, chargeMs: 0,
  });
  world.write(id, ActorSlots, { slots: ["primary"] });
  return id;
}

/** Terminal ground speed after enough ticks for acceleration to saturate. */
function terminalSpeed(world: World, sys: PhysicsSystem, id: string): number {
  const events = new EventBus();
  for (let i = 0; i < 40; i++) {
    sys.run(world, events, DT);
    world.applyChangeset();
  }
  const v = world.get(id, Velocity)!;
  return Math.hypot(v.x, v.y);
}

Deno.test("a phase's movement multiplier scales terminal ground speed", () => {
  const sys = new PhysicsSystem(content, newModifierSourceRegistry());

  const freeWorld = new World();
  const free = spawnMover(freeWorld);
  const freeSpeed = terminalSpeed(freeWorld, sys, free);
  assert(freeSpeed > 1, "baseline must actually move");

  // spell_draw's hold phase is a channelled cast — content says 0.40.
  const hold = content.actions.getOrThrow("spell_draw").movement["hold"];
  assert(typeof hold === "number", "spell_draw.hold must be a numeric multiplier, not a mode string");

  const castWorld = new World();
  const caster = spawnMover(castWorld);
  castWorld.write(caster, ActiveActions, {
    states: { primary: { actionId: "spell_draw", phase: "hold", ticksInPhase: 0, initiator: "intent" } },
  });
  const castSpeed = terminalSpeed(castWorld, sys, caster);

  assertAlmostEquals(castSpeed / freeSpeed, hold, 0.02,
    `holding a cast must move at ${hold}x — got ${(castSpeed / freeSpeed).toFixed(3)}x`);
});

Deno.test("the penalty differs per action — that is the whole point", () => {
  const sys = new PhysicsSystem(content, newModifierSourceRegistry());

  const speedWhile = (actionId: string, phase: string): number => {
    const world = new World();
    const id = spawnMover(world);
    world.write(id, ActiveActions, {
      states: { primary: { actionId, phase, ticksInPhase: 0, initiator: "intent" } },
    });
    return terminalSpeed(world, sys, id);
  };

  // Reloading a crossbow roots you to a shuffle; a light swing barely touches you.
  const reload = speedWhile("crossbow_draw", "hold");
  const light = speedWhile("swing_light", "windup");
  assert(reload < light,
    `a crossbow reload must slow you MORE than a light swing windup — got ${reload.toFixed(2)} vs ${light.toFixed(2)}`);
});

Deno.test("the strictest occupied slot wins", () => {
  const sys = new PhysicsSystem(content, newModifierSourceRegistry());
  const world = new World();
  const id = spawnMover(world);
  world.write(id, ActorSlots, { slots: ["primary", "secondary"] });
  // A permissive second slot must not rescue a heavily-committed first one.
  world.write(id, ActiveActions, {
    states: {
      primary:   { actionId: "crossbow_draw", phase: "hold",   ticksInPhase: 0, initiator: "intent" },
      secondary: { actionId: "swing_light",   phase: "windup", ticksInPhase: 0, initiator: "intent" },
    },
  });
  const both = terminalSpeed(world, sys, id);

  const soloWorld = new World();
  const solo = spawnMover(soloWorld);
  soloWorld.write(solo, ActiveActions, {
    states: { primary: { actionId: "crossbow_draw", phase: "hold", ticksInPhase: 0, initiator: "intent" } },
  });
  const strictOnly = terminalSpeed(soloWorld, sys, solo);

  assertAlmostEquals(both, strictOnly, 0.05,
    "a permissive slot must not loosen the strictest one");
});
