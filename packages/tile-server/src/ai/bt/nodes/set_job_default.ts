/**
 * Generates a default job when nothing else matched:
 *   40% → idle for tuning.idleTicks
 *   60% → wander to a random point within tuning.wanderRadius
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";

const IDLE_CHANCE = 0.4;
const TILE_MIN = 1;
const TILE_MAX = 511;

export const setJobDefaultFactory: BTNodeFactory = {
  id: "set_job_default",
  build(): BTNode {
    return {
      tick(ctx: BTContext, out: BTOutput): NodeResult {
        if (Math.random() < IDLE_CHANCE) {
          out.replaceCurrent = { type: "idle", expiresAt: ctx.currentTick + ctx.tuning.idleTicks };
          return "success";
        }
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * ctx.tuning.wanderRadius;
        const tx = Math.max(TILE_MIN, Math.min(TILE_MAX, ctx.pos.x + Math.cos(angle) * radius));
        const ty = Math.max(TILE_MIN, Math.min(TILE_MAX, ctx.pos.y + Math.sin(angle) * radius));
        out.replaceCurrent = {
          type: "wander", targetX: tx, targetY: ty,
          expiresAt: ctx.currentTick + ctx.tuning.wanderTicks,
        };
        return "success";
      },
    };
  },
};
