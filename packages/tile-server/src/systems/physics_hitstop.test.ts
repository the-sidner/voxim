/**
 * PhysicsSystem × hitstop (T-296) — the actual consumption site. Confirms a
 * frozen entity (per `collectHitStopFreezes`) holds its position and zeroes
 * velocity for the freeze window, and resumes normal integration once the
 * window elapses — the real-system counterpart to `combat/hitstop.test.ts`'s
 * pure-function coverage.
 */
import { assertEquals } from "jsr:@std/assert";
import { EventBus, World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Position, Velocity, Facing, InputState } from "../components/game.ts";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { PhysicsSystem } from "./physics.ts";

const content = await JsonSource.load();
const HEAVY_HITSTOP_TICKS = content.actions.getOrThrow("swing_heavy").hitStopTicks!;

function spawnMover(world: World, x: number): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x, y: 0, z: 0 });
  world.write(id, Velocity, { x: 0, y: 0, z: 0 });
  world.write(id, Facing, { angle: 0 });
  // Moving forward (+x) so a non-frozen tick would visibly advance position.
  world.write(id, InputState, {
    seq: 0, timestamp: 0, facing: 0, movementX: 1, movementY: 0, actions: 0,
    rttMs: 0, chargeMs: 0,
  });
  return id;
}

Deno.test("PhysicsSystem: a hitstop-frozen entity holds position + zero velocity, then resumes", () => {
  const world = new World();
  const events = new EventBus();
  const sys = new PhysicsSystem(content, newModifierSourceRegistry());

  const attacker = spawnMover(world, 0);
  const target = spawnMover(world, 5);
  world.write(attacker, ActorSlots, { slots: ["primary"] });

  const enterTick = 100;
  const untilTick = enterTick + HEAVY_HITSTOP_TICKS;
  world.write(attacker, ActiveActions, {
    states: {
      primary: {
        actionId: "swing_heavy",
        phase: "active", ticksInPhase: 0, initiator: "intent",
        scratch: {
          rewindTick: enterTick,
          hits: [{ entityId: target, bodyPart: "torso" }],
          hitStopUntilTick: untilTick,
          hitStopTargets: [{ entityId: target, untilTick }],
        },
      },
    },
  });
  world.applyChangeset();

  const attackerStart = world.get(attacker, Position)!;
  const targetStart = world.get(target, Position)!;

  // One tick inside the freeze window: both entities held in place.
  sys.prepare(enterTick + 1);
  sys.run(world, events, 1 / 20);
  world.applyChangeset();

  assertEquals(world.get(attacker, Position), attackerStart, "attacker position held during hitstop");
  assertEquals(world.get(target, Position), targetStart, "target position held during hitstop");
  assertEquals(world.get(attacker, Velocity), { x: 0, y: 0, z: 0 }, "attacker velocity zeroed during hitstop");
  assertEquals(world.get(target, Velocity), { x: 0, y: 0, z: 0 }, "target velocity zeroed during hitstop");

  // Past the window: normal integration resumes for the TARGET (it carries
  // no ActiveActions of its own, so nothing but hitstop could ever hold it).
  // The attacker stays locked here too, but that's swing_heavy's OWN
  // `movement.active: "locked"` — unrelated to hitstop and unchanged by it
  // (confirmed separately: hitstop only ADDS entries to the frozen set, it
  // never widens or narrows the pre-existing movement-lock check).
  // Several ticks so ground accel has visibly ramped velocity into motion.
  for (let tick = untilTick + 1; tick <= untilTick + 10; tick++) {
    sys.prepare(tick);
    sys.run(world, events, 1 / 20);
    world.applyChangeset();
  }

  const targetAfter = world.get(target, Position)!;
  assertEquals(targetAfter.x > targetStart.x, true, "target resumes moving once the freeze window elapses");
});
