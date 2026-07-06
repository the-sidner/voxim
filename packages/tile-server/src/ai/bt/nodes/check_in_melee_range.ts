/**
 * check_in_melee_range (T-299) — success when the NPC's current job is
 * `attackTarget` AND the target is within `tuning.attackRangeSq` — the SAME
 * distance test `attackTargetJob.tick()` already uses to decide "stop and
 * swing" vs "keep approaching". Lets a tree gate a signature `request_action`
 * (e.g. the Heavy-Thrower's telegraphed overhead) behind actually being in
 * range, instead of firing the request every tick regardless of distance.
 *
 * Entity-generic: reads `ctx.queue.current`/`ctx.pos`/`ctx.tuning` like any
 * other check node — no archetype-specific branching.
 */
import type { BTNode, BTNodeFactory, BTContext, NodeResult } from "../behavior_tree.ts";
import { Position } from "../../../components/game.ts";

export const checkInMeleeRangeFactory: BTNodeFactory = {
  id: "check_in_melee_range",
  build(): BTNode {
    return {
      tick(ctx: BTContext): NodeResult {
        const job = ctx.queue.current;
        if (!job || job.type !== "attackTarget") return "failure";
        const targetPos = ctx.world.get(job.targetId, Position);
        if (!targetPos) return "failure";
        const dx = targetPos.x - ctx.pos.x;
        const dy = targetPos.y - ctx.pos.y;
        const distSq = dx * dx + dy * dy;
        return distSq <= ctx.tuning.attackRangeSq ? "success" : "failure";
      },
    };
  },
};
