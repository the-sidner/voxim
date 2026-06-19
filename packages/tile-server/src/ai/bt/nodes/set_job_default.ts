/**
 * Generates a default job when nothing else matched:
 *   social → drift toward a nearby fellow NPC so idle NPCs cluster (T-043)
 *   40%    → idle for tuning.idleTicks
 *   60%    → wander to a random point within tuning.wanderRadius
 *
 * The social drift only fires for mobile NPCs (wanderRadius > 0) with a fellow
 * in range and only `socialIdleChance` of the time; otherwise it falls through
 * to the idle/wander roll. Stationary NPCs (wanderRadius 0, e.g. a vendor at its
 * stall) never leave to socialise.
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";
import { findNearestNpc } from "../../plan_helpers.ts";
import { Position } from "../../../components/game.ts";

const IDLE_CHANCE = 0.4;
const TILE_MIN = 1;
const TILE_MAX = 511;
/** Stop this far short of the fellow NPC — gather *around* it, not on top of it. */
const SOCIAL_STANDOFF = 1.5;

const clampTile = (v: number) => Math.max(TILE_MIN, Math.min(TILE_MAX, v));

export const setJobDefaultFactory: BTNodeFactory = {
  id: "set_job_default",
  build(): BTNode {
    return {
      tick(ctx: BTContext, out: BTOutput): NodeResult {
        // Social idle (T-043): a mobile, idle NPC sometimes drifts toward a
        // nearby fellow so idle NPCs cluster and read as socialising.
        if (ctx.tuning.wanderRadius > 0 && Math.random() < ctx.defaults.socialIdleChance) {
          const r = ctx.defaults.socialScanRadius;
          const friend = findNearestNpc(ctx.spatial, ctx.world, ctx.entityId, ctx.pos.x, ctx.pos.y, r * r);
          if (friend) {
            const fp = ctx.world.get(friend, Position)!;
            const dx = ctx.pos.x - fp.x;
            const dy = ctx.pos.y - fp.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            out.replaceCurrent = {
              type: "wander",
              targetX: clampTile(fp.x + (dx / d) * SOCIAL_STANDOFF),
              targetY: clampTile(fp.y + (dy / d) * SOCIAL_STANDOFF),
              expiresAt: ctx.currentTick + ctx.tuning.wanderTicks,
            };
            return "success";
          }
        }

        if (Math.random() < IDLE_CHANCE) {
          out.replaceCurrent = { type: "idle", expiresAt: ctx.currentTick + ctx.tuning.idleTicks };
          return "success";
        }
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * ctx.tuning.wanderRadius;
        out.replaceCurrent = {
          type: "wander",
          targetX: clampTile(ctx.pos.x + Math.cos(angle) * radius),
          targetY: clampTile(ctx.pos.y + Math.sin(angle) * radius),
          expiresAt: ctx.currentTick + ctx.tuning.wanderTicks,
        };
        return "success";
      },
    };
  },
};
