/**
 * Success when queue.current?.type !== the configured job type.
 * Used to guard emergency branches so they don't re-fire every tick.
 *
 * Spec: { type: "check_current_job_not", jobType: "seekFood" }
 */
import type { BTNode, BTNodeFactory, BTContext, NodeResult } from "../behavior_tree.ts";

export const checkCurrentJobNotFactory: BTNodeFactory = {
  id: "check_current_job_not",
  build(spec: unknown): BTNode {
    const jobType = (spec as { jobType?: unknown }).jobType;
    if (typeof jobType !== "string") {
      throw new Error(`check_current_job_not: "jobType" must be a string, got ${typeof jobType}`);
    }
    return {
      tick(ctx: BTContext): NodeResult {
        return ctx.queue.current?.type !== jobType ? "success" : "failure";
      },
    };
  },
};
