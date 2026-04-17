/**
 * Success when ctx.healthCurrent < ctx.healthMax × tuning.fleeHealthRatio.
 * Always fails when fleeHealthRatio is 0 (never flee).
 */
import type { BTNode, BTNodeFactory, BTContext, NodeResult } from "../behavior_tree.ts";

export const checkHealthCriticalFactory: BTNodeFactory = {
  id: "check_health_critical",
  build(): BTNode {
    return {
      tick(ctx: BTContext): NodeResult {
        if (ctx.tuning.fleeHealthRatio <= 0) return "failure";
        return ctx.healthCurrent < ctx.healthMax * ctx.tuning.fleeHealthRatio ? "success" : "failure";
      },
    };
  },
};
