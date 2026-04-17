/**
 * SeekWater — locate the nearest water item and walk to it. When within
 * pickup range, consume the item (reducing Thirst) and transition to idle.
 *
 * Structurally identical to seek_food but operates on Thirst / waterValue.
 */
import type { GameConfig } from "@voxim/content";
import type {
  JobHandler,
  JobContext,
  JobTickAction,
  JobTickInput,
} from "../job_handler.ts";
import type { Job, NpcPlanData } from "../../components/npcs.ts";
import { moveSteps, findNearestConsumable } from "../plan_helpers.ts";
import { Thirst } from "../../components/game.ts";

export const seekWaterJob: JobHandler = {
  id: "seekWater",
  expiryTicks(defaults: GameConfig["npcAiDefaults"]): number {
    // seekWaterTicks is not a separate field; water emergency reuses seekFoodTicks.
    return defaults.seekFoodTicks;
  },
  plan(ctx: JobContext, job: Job): NpcPlanData | null {
    if (job.type !== "seekWater") return null;
    const target = findNearestConsumable(
      ctx.spatial, ctx.world, ctx.pos.x, ctx.pos.y, ctx.content, "water", ctx.defaults.seekScanRadius,
    );
    if (!target) {
      const angle = Math.random() * Math.PI * 2;
      const tx = ctx.pos.x + Math.cos(angle) * 20;
      const ty = ctx.pos.y + Math.sin(angle) * 20;
      return {
        steps: moveSteps(ctx.pos.x, ctx.pos.y, tx, ty, ctx.defaults.waypointSpacing),
        stepIdx: 0,
        expiresAt: ctx.currentTick + ctx.defaults.planExpiryTicks,
      };
    }
    return {
      steps: moveSteps(ctx.pos.x, ctx.pos.y, target.x, target.y, ctx.defaults.waypointSpacing),
      stepIdx: 0,
      expiresAt: ctx.currentTick + ctx.defaults.planExpiryTicks,
    };
  },
  tick(input: JobTickInput): JobTickAction {
    const { ctx } = input;
    const water = findNearestConsumable(
      ctx.spatial, ctx.world, ctx.pos.x, ctx.pos.y, ctx.content, "water", ctx.defaults.seekScanRadius,
    );
    if (water) {
      const dx = water.x - ctx.pos.x;
      const dy = water.y - ctx.pos.y;
      if (dx * dx + dy * dy <= ctx.defaults.foodPickupRangeSq) {
        const thirst = ctx.world.get(ctx.entityId, Thirst);
        if (thirst) {
          ctx.world.set(ctx.entityId, Thirst, {
            value: Math.max(0, thirst.value - ctx.tuning.waterThirstRestore),
          });
        }
        ctx.world.destroy(water.entityId);
        return {
          movementX: 0, movementY: 0, actions: 0,
          replaceJob: { type: "idle", expiresAt: ctx.currentTick + 20 },
        };
      }
    }
    return { movementX: input.planDirX, movementY: input.planDirY, actions: 0 };
  },
};
