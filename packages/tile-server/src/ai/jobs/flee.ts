/**
 * Flee — run in a straight line away from (job.fromX, job.fromY) to a
 * point 24 units away, clamped to the tile bounds.
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

const FLEE_DISTANCE = 24;
const TILE_MIN = 1;
const TILE_MAX = 511;

export const fleeJob: JobHandler = {
  id: "flee",
  expiryTicks(defaults: GameConfig["npcAiDefaults"]): number {
    return defaults.planExpiryTicks;
  },
  plan(ctx: JobContext, job: Job): NpcPlanData | null {
    if (job.type !== "flee") return null;
    const dx = ctx.pos.x - job.fromX;
    const dy = ctx.pos.y - job.fromY;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const fleeX = Math.max(TILE_MIN, Math.min(TILE_MAX, ctx.pos.x + (dx / dist) * FLEE_DISTANCE));
    const fleeY = Math.max(TILE_MIN, Math.min(TILE_MAX, ctx.pos.y + (dy / dist) * FLEE_DISTANCE));
    return {
      steps: moveSteps(ctx.pos.x, ctx.pos.y, fleeX, fleeY, ctx.defaults.waypointSpacing),
      stepIdx: 0,
      expiresAt: ctx.currentTick + ctx.defaults.planExpiryTicks,
    };
  },
  tick(input: JobTickInput): JobTickAction {
    return { movementX: input.planDirX, movementY: input.planDirY, actions: 0 };
  },
};
