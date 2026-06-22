/**
 * Aggro scan — finds the nearest non-NPC target within aggroRangeSq.
 *   - Target found: emits attackTarget job; returns success.
 *   - No target:    writes a cooldown plan (throttles repeat scans) and
 *                   returns success. The selector treats the aggro branch
 *                   as handled either way so subsequent branches don't fire
 *                   in the same tick.
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";
import { findDetectedThreat } from "../../plan_helpers.ts";
import { Facing } from "../../../components/game.ts";
import { getLightAt } from "../../../components/light.ts";

export const setJobAttackNearestFactory: BTNodeFactory = {
  id: "set_job_attack_nearest",
  build(): BTNode {
    return {
      tick(ctx: BTContext, out: BTOutput): NodeResult {
        // Unified detection (T-015): sight (forward cone) + hearing (target
        // noise × proximity) + a short proximity sense. Frontal approach always
        // caught; a quiet croucher can flank; a sprinter behind is heard.
        // Darkness (T-017) shrinks the range — an NPC standing in the dark
        // detects threats at a reduced radius (lit torches/fires extend it back).
        const facing = ctx.world.get(ctx.entityId, Facing)?.angle ?? 0;
        const lightLevel = getLightAt(ctx.world, ctx.pos.x, ctx.pos.y);
        const target = findDetectedThreat(
          ctx.spatial, ctx.world, ctx.entityId, ctx.pos.x, ctx.pos.y, facing,
          ctx.tuning.aggroRangeSq,
          ctx.defaults.aggroConeHalfAngle,
          ctx.tuning.aggroRangeSq * ctx.defaults.aggroRearRangeRatio,
          ctx.defaults.aggroAuditoryThreshold,
          lightLevel,
          ctx.defaults.nightDetectionRangeMultiplier,
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
