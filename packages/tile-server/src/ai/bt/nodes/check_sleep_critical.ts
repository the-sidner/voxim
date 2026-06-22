/**
 * Success when ctx.sleep >= tuning.sleepEmergency (T-039).
 */
import type { BTNode, BTNodeFactory, BTContext, NodeResult } from "../behavior_tree.ts";

export const checkSleepCriticalFactory: BTNodeFactory = {
  id: "check_sleep_critical",
  build(): BTNode {
    return {
      tick(ctx: BTContext): NodeResult {
        return ctx.sleep >= ctx.tuning.sleepEmergency ? "success" : "failure";
      },
    };
  },
};
