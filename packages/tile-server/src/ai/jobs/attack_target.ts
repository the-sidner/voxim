/**
 * AttackTarget — approach a target entity and emit ACTION_USE_SKILL when
 * in melee range.
 *
 * Plan: approach from the NPC's current angle to just outside attack range
 *   (spreads a pack around the target instead of stacking on one point).
 * Replan: target drifted far from `lastKnownTarget{X,Y}`.
 * Tick: if target gone, clear the job; if in range, stop + swing + face; else
 *   follow the plan.
 *
 * T-338: a continuously-held ACTION_USE_SKILL is harmless for melee (each
 * `kind:"active"` swing self-terminates and PrimaryIntentResolver
 * immediately restarts the next one) but WRONG for a hold-to-aim weapon
 * (bow_draw etc.) — its perpetual hold phase never ends on its own, so an
 * NPC holding the bit forever would draw and never fire. `releasePulse`
 * below detects exactly that shape (the running action names a
 * releaseActionId AND its current phase is perpetual) generically, off the
 * RUNNING action's own data — never branching on "is this a bow" — and
 * emits one release tick (actions: 0) once it's been held
 * `npcAiDefaults.rangedHoldTicks`.
 */
import type { GameConfig } from "@voxim/content";
import { ACTION_USE_SKILL } from "@voxim/protocol";
import type {
  JobHandler,
  JobContext,
  JobTickAction,
  JobTickInput,
} from "../job_handler.ts";
import type { Job, NpcPlanData } from "../../components/npcs.ts";
import { Position } from "../../components/game.ts";
import { ActiveActions } from "../../components/action.ts";
import { moveSteps } from "../plan_helpers.ts";

/**
 * True when `ctx.entityId`'s primary slot is holding a hold-to-aim charge
 * (a releaseActionId-bearing action, currently in its perpetual phase) for
 * at least `ctx.defaults.rangedHoldTicks` ticks — the release-pulse
 * condition. Weapon-agnostic by construction: reads only the shape the
 * dispatcher already exposes.
 */
function shouldReleaseHold(ctx: JobContext): boolean {
  const state = ctx.world.get(ctx.entityId, ActiveActions)?.states["primary"];
  if (!state) return false;
  const def = ctx.content.actions.get(state.actionId);
  if (!def?.releaseActionId) return false;
  const phase = def.phases[state.phase];
  if (phase?.ticks !== -1) return false;
  return state.ticksInPhase >= ctx.defaults.rangedHoldTicks;
}

export const attackTargetJob: JobHandler = {
  id: "attackTarget",

  expiryTicks(defaults: GameConfig["npcAiDefaults"]): number {
    return defaults.attackPlanExpiryTicks;
  },

  plan(ctx: JobContext, job: Job): NpcPlanData | null {
    if (job.type !== "attackTarget") return null;
    const targetPos = ctx.world.get(job.targetId, Position);
    if (!targetPos) return null;
    const approachRadius = Math.sqrt(ctx.tuning.attackRangeSq) * 0.85;
    const dx0 = ctx.pos.x - targetPos.x;
    const dy0 = ctx.pos.y - targetPos.y;
    const dist0 = Math.sqrt(dx0 * dx0 + dy0 * dy0) || 1;
    const destX = targetPos.x + (dx0 / dist0) * approachRadius;
    const destY = targetPos.y + (dy0 / dist0) * approachRadius;
    return {
      steps: moveSteps(ctx.pos.x, ctx.pos.y, destX, destY, ctx.defaults.waypointSpacing),
      stepIdx: 0,
      expiresAt: ctx.currentTick + ctx.defaults.attackPlanExpiryTicks,
      lastKnownTargetX: targetPos.x,
      lastKnownTargetY: targetPos.y,
    };
  },

  needsReplan(ctx: JobContext, job: Job, plan: NpcPlanData): boolean {
    if (job.type !== "attackTarget") return false;
    if (plan.lastKnownTargetX === undefined) return false;
    const targetPos = ctx.world.get(job.targetId, Position);
    if (!targetPos) return false;
    const dx = targetPos.x - plan.lastKnownTargetX;
    const dy = targetPos.y - (plan.lastKnownTargetY ?? 0);
    return dx * dx + dy * dy > ctx.defaults.attackReplanDistSq;
  },

  tick(input: JobTickInput): JobTickAction {
    const { ctx, job } = input;
    if (job.type !== "attackTarget") {
      return { movementX: 0, movementY: 0, actions: 0 };
    }

    // Target disappeared (despawn/death) — clear the job so fallback runs next tick.
    if (!ctx.world.isAlive(job.targetId)) {
      return { movementX: 0, movementY: 0, actions: 0, clearJob: true };
    }

    const targetPos = ctx.world.get(job.targetId, Position);
    if (!targetPos) {
      return { movementX: 0, movementY: 0, actions: 0, clearJob: true };
    }

    const dx = targetPos.x - ctx.pos.x;
    const dy = targetPos.y - ctx.pos.y;
    const distSq = dx * dx + dy * dy;
    const inRange = distSq <= ctx.tuning.attackRangeSq;
    const faceTarget = Math.atan2(dy, dx);

    if (inRange) {
      return {
        movementX: 0, movementY: 0,
        actions: shouldReleaseHold(ctx) ? 0 : ACTION_USE_SKILL,
        facing: faceTarget,
      };
    }
    return {
      movementX: input.planDirX,
      movementY: input.planDirY,
      actions: 0,
    };
  },
};
