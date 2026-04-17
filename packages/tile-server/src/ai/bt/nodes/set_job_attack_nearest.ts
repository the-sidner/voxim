/**
 * Aggro scan — finds the nearest non-NPC target within aggroRangeSq.
 *   - Target found: emits attackTarget job; returns success.
 *   - No target:    writes a cooldown plan (throttles repeat scans) and
 *                   returns success. The selector treats the aggro branch
 *                   as handled either way so subsequent branches don't fire
 *                   in the same tick.
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";
import { findNearestNonNpc } from "../../plan_helpers.ts";

export const setJobAttackNearestFactory: BTNodeFactory = {
  id: "set_job_attack_nearest",
  build(): BTNode {
    return {
      tick(ctx: BTContext, out: BTOutput): NodeResult {
        const target = findNearestNonNpc(
          ctx.spatial, ctx.world, ctx.entityId, ctx.pos.x, ctx.pos.y, ctx.tuning.aggroRangeSq,
        );
        if (target) {
          out.replaceCurrent = {
            type: "attackTarget",
            targetId: target.entityId,
            expiresAt: ctx.currentTick + ctx.tuning.attackTicks,
          };
        } else {
          out.cooldownPlan = {
            steps: [], stepIdx: 0,
            expiresAt: ctx.currentTick + ctx.defaults.attackPlanExpiryTicks,
          };
        }
        return "success";
      },
    };
  },
};
