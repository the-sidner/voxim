/**
 * attackTargetJob (T-338 regression guard): a continuously-held
 * ACTION_USE_SKILL is fine for melee (each swing self-terminates and
 * restarts) but WRONG for a hold-to-aim weapon — its perpetual hold phase
 * never ends on its own. Confirms attackTargetJob emits a release pulse
 * once `rangedHoldTicks` have elapsed while holding, and keeps emitting
 * ACTION_USE_SKILL continuously for an ordinary melee weapon (no change in
 * behaviour there).
 */
import { assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { ACTION_USE_SKILL } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import { Position } from "../../components/game.ts";
import { ActiveActions } from "../../components/action.ts";
import { attackTargetJob } from "./attack_target.ts";
import type { JobContext, JobTickInput } from "../job_handler.ts";
import type { Job } from "../../components/npcs.ts";

const content = await JsonSource.load();

function ctxFor(world: World, entityId: string, x: number, y: number): JobContext {
  return {
    world,
    entityId,
    pos: { x, y },
    spatial: null as unknown as JobContext["spatial"],
    content,
    currentTick: 0,
    tuning: { attackRangeSq: 100 } as unknown as JobContext["tuning"],
    defaults: content.getGameConfig().npcAiDefaults,
  };
}

function attackJob(targetId: string): Job {
  return { type: "attackTarget", targetId, expiresAt: 1000 };
}

function input(ctx: JobContext, job: Job): JobTickInput {
  return { ctx, job, plan: null, planDirX: 0, planDirY: 0 };
}

function inRangeSetup(): { world: World; npc: string; target: string } {
  const world = new World();
  const npc = newEntityId();
  world.create(npc);
  world.write(npc, Position, { x: 0, y: 0, z: 0 });
  const target = newEntityId();
  world.create(target);
  world.write(target, Position, { x: 1, y: 0, z: 0 }); // well within attackRangeSq: 100
  return { world, npc, target };
}

Deno.test("attackTargetJob: melee (no primary action running) emits ACTION_USE_SKILL every tick, unconditionally", () => {
  const { world, npc, target } = inRangeSetup();
  const ctx = ctxFor(world, npc, 0, 0);
  for (let i = 0; i < 5; i++) {
    const action = attackTargetJob.tick(input(ctx, attackJob(target)));
    assertEquals(action.actions, ACTION_USE_SKILL);
  }
});

Deno.test("attackTargetJob: holding a hold-to-aim charge past rangedHoldTicks emits a release pulse", () => {
  const { world, npc, target } = inRangeSetup();
  world.write(npc, ActiveActions, {
    states: {
      primary: {
        actionId: "bow_draw",
        phase: "hold", // perpetual phase — content.actions.get("bow_draw").releaseActionId is set
        ticksInPhase: content.getGameConfig().npcAiDefaults.rangedHoldTicks, // exactly at threshold
        initiator: "intent",
      },
    },
  });
  const ctx = ctxFor(world, npc, 0, 0);
  const action = attackTargetJob.tick(input(ctx, attackJob(target)));
  assertEquals(action.actions, 0, "release pulse — no ACTION_USE_SKILL this tick");
});

Deno.test("attackTargetJob: still holds ACTION_USE_SKILL before rangedHoldTicks elapses", () => {
  const { world, npc, target } = inRangeSetup();
  world.write(npc, ActiveActions, {
    states: {
      primary: { actionId: "bow_draw", phase: "hold", ticksInPhase: 3, initiator: "intent" },
    },
  });
  const ctx = ctxFor(world, npc, 0, 0);
  const action = attackTargetJob.tick(input(ctx, attackJob(target)));
  assertEquals(action.actions, ACTION_USE_SKILL, "not yet at the release threshold");
});

Deno.test("attackTargetJob: mid-windup (not yet the perpetual hold) still holds ACTION_USE_SKILL regardless of ticksInPhase", () => {
  const { world, npc, target } = inRangeSetup();
  world.write(npc, ActiveActions, {
    states: {
      // Finite windup phase, not the perpetual hold — must not release yet
      // even with a large ticksInPhase.
      primary: { actionId: "bow_draw", phase: "windup", ticksInPhase: 999, initiator: "intent" },
    },
  });
  const ctx = ctxFor(world, npc, 0, 0);
  const action = attackTargetJob.tick(input(ctx, attackJob(target)));
  assertEquals(action.actions, ACTION_USE_SKILL);
});
