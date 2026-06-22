/**
 * SeekBed — locate the nearest placed bed and walk to it. When within range,
 * stand still and rest: refill the `sleep` resource each tick until it
 * empties, then transition to idle (T-039).
 *
 * Mirrors seek_food / seek_water, but the target is a static placed prop
 * (a `bed` prefab entity, identified by SpawnedFrom) and the restorative
 * action is a per-tick drain of the tiredness gauge rather than a one-shot
 * consume. v1 is stateless: first-come proximity, no bed-occupancy claim —
 * two tired NPCs may rest at the same bed.
 */
import type { GameConfig } from "@voxim/content";
import type { World, EntityId } from "@voxim/engine";
import type {
  JobHandler,
  JobContext,
  JobTickAction,
  JobTickInput,
} from "../job_handler.ts";
import type { Job, NpcPlanData } from "../../components/npcs.ts";
import { Position } from "../../components/game.ts";
import { Resource } from "../../components/resource.ts";
import { SpawnedFrom } from "../../components/spawned_from.ts";
import { moveSteps } from "../plan_helpers.ts";
import { adjustResourceKey } from "../../resources/mutate.ts";

const BED_PREFAB_ID = "bed";
const NO_ACTION: JobTickAction = { movementX: 0, movementY: 0, actions: 0 };

/** Nearest placed `bed` prop entity within `scanRadius`, by prefab id. */
function findNearestBed(
  world: World,
  px: number,
  py: number,
  scanRadius: number,
): { entityId: EntityId; x: number; y: number } | null {
  const scanSq = scanRadius * scanRadius;
  let best: { entityId: EntityId; x: number; y: number } | null = null;
  let bestDistSq = scanSq;
  for (const { entityId, spawnedFrom } of world.query(SpawnedFrom)) {
    if (spawnedFrom.prefabId !== BED_PREFAB_ID) continue;
    const pos = world.get(entityId, Position);
    if (!pos) continue;
    const dx = pos.x - px;
    const dy = pos.y - py;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) { bestDistSq = dSq; best = { entityId, x: pos.x, y: pos.y }; }
  }
  return best;
}

export const seekBedJob: JobHandler = {
  id: "seekBed",
  expiryTicks(defaults: GameConfig["npcAiDefaults"]): number {
    return defaults.seekBedTicks;
  },
  plan(ctx: JobContext, job: Job): NpcPlanData | null {
    if (job.type !== "seekBed") return null;
    const target = findNearestBed(ctx.world, ctx.pos.x, ctx.pos.y, ctx.defaults.seekScanRadius);
    if (!target) {
      // Wander in a random direction while searching for a bed.
      const angle = Math.random() * Math.PI * 2;
      const tx = ctx.pos.x + Math.cos(angle) * 20;
      const ty = ctx.pos.y + Math.sin(angle) * 20;
      return {
        steps: moveSteps(ctx.pos.x, ctx.pos.y, tx, ty, ctx.defaults.waypointSpacing),
        stepIdx: 0,
        expiresAt: ctx.currentTick + ctx.defaults.planExpiryTicks,
      };
    }
    return {
      steps: moveSteps(ctx.pos.x, ctx.pos.y, target.x, target.y, ctx.defaults.waypointSpacing),
      stepIdx: 0,
      expiresAt: ctx.currentTick + ctx.defaults.planExpiryTicks,
    };
  },
  tick(input: JobTickInput): JobTickAction {
    const { ctx } = input;
    const bed = findNearestBed(ctx.world, ctx.pos.x, ctx.pos.y, ctx.defaults.seekScanRadius);
    if (bed) {
      const dx = bed.x - ctx.pos.x;
      const dy = bed.y - ctx.pos.y;
      if (dx * dx + dy * dy <= ctx.defaults.bedRangeSq) {
        // At the bed. Read the committed tiredness; once this tick's drain
        // would empty it, we're rested — stop resting and idle. (The drain is
        // deferred/composing, T-249, so the new value isn't readable here;
        // we gate on the pre-drain value instead.)
        const sleep = ctx.world.get(ctx.entityId, Resource)?.values.sleep?.value ?? 0;
        if (sleep <= ctx.tuning.bedSleepRestore) {
          adjustResourceKey(ctx.world, ctx.entityId, "sleep", -ctx.tuning.bedSleepRestore);
          return { ...NO_ACTION, replaceJob: { type: "idle", expiresAt: ctx.currentTick + 20 } };
        }
        // Still tired: rest one more tick (composing delta, T-249).
        adjustResourceKey(ctx.world, ctx.entityId, "sleep", -ctx.tuning.bedSleepRestore);
        return { ...NO_ACTION };
      }
    }
    return { movementX: input.planDirX, movementY: input.planDirY, actions: 0 };
  },
};
