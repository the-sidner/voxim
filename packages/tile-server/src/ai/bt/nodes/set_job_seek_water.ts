/**
 * Emits a seekWater job into BTOutput. Duration = tuning.seekFoodTicks
 * (water reuses the seek-food timeout; distinct field can be added later).
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";

export const setJobSeekWaterFactory: BTNodeFactory = {
  id: "set_job_seek_water",
  build(): BTNode {
    return {
      tick(ctx: BTContext, out: BTOutput): NodeResult {
        out.replaceCurrent = { type: "seekWater", expiresAt: ctx.currentTick + ctx.tuning.seekFoodTicks };
        return "success";
      },
    };
  },
};
