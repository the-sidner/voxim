/**
 * Scans within `defaults.seekScanRadius` for a nearest other entity and
 * emits a flee job. If nothing is found, flees to a random nearby point.
 * Always succeeds.
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";
import { findNearestOther } from "../../plan_helpers.ts";

export const setJobFleeFromNearestFactory: BTNodeFactory = {
  id: "set_job_flee_from_nearest",
  build(): BTNode {
    return {
      tick(ctx: BTContext, out: BTOutput): NodeResult {
        const threat = findNearestOther(
          ctx.spatial, ctx.world, ctx.entityId, ctx.pos.x, ctx.pos.y, ctx.defaults.seekScanRadius,
        );
        out.replaceCurrent = {
          type: "flee",
          fromX: threat?.x ?? ctx.pos.x + (Math.random() - 0.5) * 20,
          fromY: threat?.y ?? ctx.pos.y + (Math.random() - 0.5) * 20,
          expiresAt: ctx.currentTick + ctx.tuning.fleeTicks,
        };
        return "success";
      },
    };
  },
};
