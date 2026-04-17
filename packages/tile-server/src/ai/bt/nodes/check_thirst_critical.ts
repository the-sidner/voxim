/**
 * Success when ctx.thirst >= tuning.thirstEmergency.
 */
import type { BTNode, BTNodeFactory, BTContext, NodeResult } from "../behavior_tree.ts";

export const checkThirstCriticalFactory: BTNodeFactory = {
  id: "check_thirst_critical",
  build(): BTNode {
    return {
      tick(ctx: BTContext): NodeResult {
        return ctx.thirst >= ctx.tuning.thirstEmergency ? "success" : "failure";
      },
    };
  },
};
