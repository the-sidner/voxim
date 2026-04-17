/**
 * Wander — walk to a random nearby point.
 *
 * Plan: straight line to (job.targetX, job.targetY).
 * Tick: follow the plan direction advanced by NpcAiSystem.
 */
import type { GameConfig } from "@voxim/content";
import type {
  JobHandler,
  JobContext,
  JobTickAction,
  JobTickInput,
} from "../job_handler.ts";
import type { Job, NpcPlanData } from "../../components/npcs.ts";
import { moveSteps } from "../plan_helpers.ts";

export const wanderJob: JobHandler = {
  id: "wander",
  expiryTicks(defaults: GameConfig["npcAiDefaults"]): number {
    return defaults.planExpiryTicks;
  },
  plan(ctx: JobContext, job: Job): NpcPlanData | null {
    if (job.type !== "wander") return null;
    return {
      steps: moveSteps(ctx.pos.x, ctx.pos.y, job.targetX, job.targetY, ctx.defaults.waypointSpacing),
      stepIdx: 0,
      expiresAt: ctx.currentTick + ctx.defaults.planExpiryTicks,
    };
  },
  tick(input: JobTickInput): JobTickAction {
    return { movementX: input.planDirX, movementY: input.planDirY, actions: 0 };
  },
};
