/**
 * Success when ctx.hunger >= tuning.hungerEmergency.
 */
import type { BTNode, BTNodeFactory, BTContext, NodeResult } from "../behavior_tree.ts";

export const checkHungerCriticalFactory: BTNodeFactory = {
  id: "check_hunger_critical",
  build(): BTNode {
    return {
      tick(ctx: BTContext): NodeResult {
        return ctx.hunger >= ctx.tuning.hungerEmergency ? "success" : "failure";
      },
    };
  },
};
