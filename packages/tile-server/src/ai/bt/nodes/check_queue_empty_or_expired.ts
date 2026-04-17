/**
 * Success when queue.current is null or its expiry tick has been reached.
 * Used by the fallback branch: generate a new default job when nothing is
 * running.
 */
import type { BTNode, BTNodeFactory, BTContext, NodeResult } from "../behavior_tree.ts";

export const checkQueueEmptyOrExpiredFactory: BTNodeFactory = {
  id: "check_queue_empty_or_expired",
  build(): BTNode {
    return {
      tick(ctx: BTContext): NodeResult {
        const cur = ctx.queue.current;
        if (!cur) return "success";
        return ctx.currentTick >= cur.expiresAt ? "success" : "failure";
      },
    };
  },
};
