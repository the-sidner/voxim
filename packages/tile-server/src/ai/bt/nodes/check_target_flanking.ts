/**
 * check_target_flanking (T-299) — success when the NPC's current
 * `attackTarget` is OUTSIDE the NPC's own frontal block arc
 * (`combat.blockArcHalfRadians`), i.e. the attacker isn't in the half-space
 * the NPC is facing. Same dot-product idiom `health_hit_handler.ts` already
 * uses for hit_front/hit_back reaction selection and the rear-multiplier
 * check (T-299) — reused here from the DEFENDER's perspective instead of the
 * attacker's, so a Shield-Knight can tell "am I about to be flanked" from
 * its own facing + the target's position.
 *
 * Drives the Shield-Knight's tree: block while faced, commit to a heavy
 * swing once flanked (the `block` primary action's frontal arc already
 * covers the "faced" half — this node covers the complementary "not faced"
 * half without any archetype-specific code, just reading Facing/Position
 * generically).
 */
import type { BTNode, BTNodeFactory, BTContext, NodeResult } from "../behavior_tree.ts";
import { Facing, Position } from "../../../components/game.ts";

export const checkTargetFlankingFactory: BTNodeFactory = {
  id: "check_target_flanking",
  build(): BTNode {
    return {
      tick(ctx: BTContext): NodeResult {
        const job = ctx.queue.current;
        if (!job || job.type !== "attackTarget") return "failure";
        const targetPos = ctx.world.get(job.targetId, Position);
        if (!targetPos) return "failure";

        const facing = ctx.world.get(ctx.entityId, Facing)?.angle ?? 0;
        const toTargetX = targetPos.x - ctx.pos.x;
        const toTargetY = targetPos.y - ctx.pos.y;
        const forwardX = Math.cos(facing);
        const forwardY = Math.sin(facing);
        const dot = toTargetX * forwardX + toTargetY * forwardY;
        const distSq = toTargetX * toTargetX + toTargetY * toTargetY;
        if (distSq < 1e-6) return "failure"; // degenerate (same position) — never "flanking"

        const dist = Math.sqrt(distSq);
        const angleOffCenter = Math.acos(Math.max(-1, Math.min(1, dot / dist)));
        const halfArc = ctx.content.getGameConfig().combat.blockArcHalfRadians;
        return angleOffCenter > halfArc ? "success" : "failure";
      },
    };
  },
};
