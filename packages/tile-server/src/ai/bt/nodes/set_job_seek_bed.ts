/**
 * Emits a seekBed job into BTOutput. Duration = tuning.seekBedTicks (T-039).
 * Always succeeds.
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";

export const setJobSeekBedFactory: BTNodeFactory = {
  id: "set_job_seek_bed",
  build(): BTNode {
    return {
      tick(ctx: BTContext, out: BTOutput): NodeResult {
        out.replaceCurrent = { type: "seekBed", expiresAt: ctx.currentTick + ctx.tuning.seekBedTicks };
        return "success";
      },
    };
  },
};
