/**
 * LocomotionIntentResolver (T-226c) — asserts the port reproduces every
 * one of the retired CSM locomotion layer's 13 transitions: priority
 * order, from-state allow-lists, velocity hysteresis (the 0.5 enter / 0.2
 * exit band), the dodge settle guard, and the mid-action "leave it alone"
 * behaviour that maps to the CSM's duration-exit-to-idle.
 */

import { assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { ACTION_JUMP, ACTION_DODGE } from "@voxim/protocol";
import { InputState, Velocity, Facing } from "../components/game.ts";
import { Airborne } from "../components/combat.ts";
import { ActiveActions } from "../components/action.ts";
import { LocomotionIntentResolver } from "./locomotion_intent.ts";

function rig(opts: {
  cur?: string;
  ticks?: number;
  vx?: number;
  vy?: number;
  facing?: number;
  jump?: boolean;
  dodge?: boolean;
  airborne?: boolean;
}) {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  world.write(id, Velocity, { x: opts.vx ?? 0, y: opts.vy ?? 0, z: 0 });
  world.write(id, Facing, { angle: opts.facing ?? 0 });
  const actions = (opts.jump ? ACTION_JUMP : 0) | (opts.dodge ? ACTION_DODGE : 0);
  world.write(id, InputState, {
    facing: 0, movementX: 0, movementY: 0, actions, chargeMs: 0, seq: 0, timestamp: 0, rttMs: 0,
  });
  if (opts.airborne) world.write(id, Airborne, {});
  const states: Record<string, unknown> = {};
  if (opts.cur) {
    states.locomotion = {
      actionId: opts.cur, phase: "hold", ticksInPhase: opts.ticks ?? 5, initiator: "ambient",
    };
  }
  world.write(id, ActiveActions, { states: states as never });
  return { world, id };
}

function want(opts: Parameters<typeof rig>[0]): string | null {
  const { world, id } = rig(opts);
  return LocomotionIntentResolver.resolve(world, id, ["locomotion"]).get("locomotion") ?? null;
}

Deno.test("empty slot picks idle when stationary", () => {
  assertEquals(want({ cur: "", vx: 0, vy: 0 }), "idle");
});

Deno.test("idle → walk_forward when forward speed exceeds 0.5", () => {
  assertEquals(want({ cur: "idle", vx: 1.0, vy: 0, facing: 0 }), "walk_forward");
});

Deno.test("velocity hysteresis: walk_forward holds in the 0.2–0.5 band", () => {
  // forward 0.3: below the 0.5 enter threshold, above the 0.2 idle exit.
  assertEquals(want({ cur: "walk_forward", vx: 0.3, vy: 0, facing: 0 }), "walk_forward");
});

Deno.test("walk_forward → idle only below 0.2", () => {
  assertEquals(want({ cur: "walk_forward", vx: 0.1, vy: 0, facing: 0 }), "idle");
});

Deno.test("strafe wins when strafe_abs strictly exceeds forward_abs", () => {
  // facing 0: right = (0,1). vy=1 → strafe=1, forward=0.
  assertEquals(want({ cur: "idle", vx: 0, vy: 1.0, facing: 0 }), "strafe_right");
  assertEquals(want({ cur: "idle", vx: 0, vy: -1.0, facing: 0 }), "strafe_left");
});

Deno.test("jump beats velocity; requires steady + !airborne", () => {
  assertEquals(want({ cur: "idle", jump: true, vx: 1.0 }), "jump");
  assertEquals(want({ cur: "idle", jump: true, airborne: true }), "airborne"); // !airborne fails → airborne rule
  assertEquals(want({ cur: "jump", jump: true }), null); // mid-jump: leave it
});

Deno.test("dodge has top priority but needs the settle guard (ticks > 1)", () => {
  assertEquals(want({ cur: "idle", ticks: 5, dodge: true, jump: true }), "sidestep");
  assertEquals(want({ cur: "idle", ticks: 1, dodge: true }), "idle"); // not settled → no sidestep
  assertEquals(want({ cur: "sidestep", dodge: true }), null); // mid-sidestep: leave it
});

Deno.test("jump → airborne mid-action; airborne → landing on touchdown", () => {
  assertEquals(want({ cur: "jump", airborne: true }), "airborne");
  assertEquals(want({ cur: "airborne", airborne: true }), null); // still airborne: hold
  assertEquals(want({ cur: "airborne", airborne: false }), "landing");
});

Deno.test("landing is committed — left alone until it completes", () => {
  assertEquals(want({ cur: "landing", vx: 2.0 }), null);
});

Deno.test("steady + airborne (walked off a ledge) → airborne", () => {
  assertEquals(want({ cur: "walk_forward", vx: 1.0, airborne: true }), "airborne");
});
