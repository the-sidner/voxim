/**
 * Emits a seekFood job into BTOutput. Duration = tuning.seekFoodTicks.
 * Always succeeds.
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";

export const setJobSeekFoodFactory: BTNodeFactory = {
  id: "set_job_seek_food",
  build(): BTNode {
    return {
      tick(ctx: BTContext, out: BTOutput): NodeResult {
        out.replaceCurrent = { type: "seekFood", expiresAt: ctx.currentTick + ctx.tuning.seekFoodTicks };
        return "success";
      },
    };
  },
};
