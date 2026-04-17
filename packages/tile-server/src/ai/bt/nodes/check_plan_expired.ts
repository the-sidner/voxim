/**
 * Success when queue.plan is missing or its expiry tick has been reached.
 * Used by the aggro-scan branch to throttle scans after a previous fail.
 */
import type { BTNode, BTNodeFactory, BTContext, NodeResult } from "../behavior_tree.ts";

export const checkPlanExpiredFactory: BTNodeFactory = {
  id: "check_plan_expired",
  build(): BTNode {
    return {
      tick(ctx: BTContext): NodeResult {
        const plan = ctx.queue.plan;
        if (!plan) return "success";
        return ctx.currentTick >= plan.expiresAt ? "success" : "failure";
      },
    };
  },
};
