/**
 * SeekFood — locate the nearest food item and walk to it. When within
 * pickup range, consume the item (reducing Hunger) and transition to idle.
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
import { Hunger } from "../../components/game.ts";

export const seekFoodJob: JobHandler = {
  id: "seekFood",
  expiryTicks(defaults: GameConfig["npcAiDefaults"]): number {
    return defaults.seekFoodTicks;
  },
  plan(ctx: JobContext, job: Job): NpcPlanData | null {
    if (job.type !== "seekFood") return null;
    const target = findNearestConsumable(
      ctx.spatial, ctx.world, ctx.pos.x, ctx.pos.y, ctx.content, "food", ctx.defaults.seekScanRadius,
    );
    if (!target) {
      // Wander in a random direction while searching.
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
    const food = findNearestConsumable(
      ctx.spatial, ctx.world, ctx.pos.x, ctx.pos.y, ctx.content, "food", ctx.defaults.seekScanRadius,
    );
    if (food) {
      const dx = food.x - ctx.pos.x;
      const dy = food.y - ctx.pos.y;
      if (dx * dx + dy * dy <= ctx.defaults.foodPickupRangeSq) {
        const hunger = ctx.world.get(ctx.entityId, Hunger);
        if (hunger) {
          ctx.world.set(ctx.entityId, Hunger, {
            value: Math.max(0, hunger.value - ctx.tuning.foodHungerRestore),
          });
        }
        ctx.world.destroy(food.entityId);
        return {
          movementX: 0, movementY: 0, actions: 0,
          replaceJob: { type: "idle", expiresAt: ctx.currentTick + 20 },
        };
      }
    }
    return { movementX: input.planDirX, movementY: input.planDirY, actions: 0 };
  },
};
