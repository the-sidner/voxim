/**
 * JobHandler interface and supporting types.
 *
 * Every NPC `Job.type` resolves to a registered `JobHandler` in the job
 * registry. NpcAiSystem owns the emergency priority cascade, queue
 * advancement, and plan execution flow — handlers own the job-specific
 * logic: how to build a plan, when to replan, per-tick movement/actions,
 * and queue transitions (auto-consume, target invalidation).
 */
import type { World, EntityId } from "@voxim/engine";
import type { ContentStore, GameConfig, NpcTemplate } from "@voxim/content";
import type { Job, NpcPlanData } from "../components/npcs.ts";
import type { SpatialGrid } from "../spatial_grid.ts";

/** Resolved per-NPC tuning. Template values override game_config defaults. */
export interface NpcTuning {
  readonly wanderRadius: number;
  readonly wanderTicks: number;
  readonly idleTicks: number;
  readonly attackTicks: number;
  readonly fleeTicks: number;
  readonly seekFoodTicks: number;
  readonly attackRangeSq: number;
  readonly aggroRangeSq: number;
  readonly hungerEmergency: number;
  readonly thirstEmergency: number;
  readonly foodHungerRestore: number;
  readonly waterThirstRestore: number;
  readonly fleeHealthRatio: number;
  readonly behavior: string;
}

export interface JobContext {
  readonly world: World;
  readonly spatial: SpatialGrid;
  readonly content: ContentStore;
  readonly currentTick: number;
  readonly entityId: EntityId;
  readonly pos: { readonly x: number; readonly y: number };
  readonly template: NpcTemplate | null;
  readonly tuning: NpcTuning;
  readonly defaults: GameConfig["npcAiDefaults"];
}

/**
 * Per-tick handler output. Movement + actions + facing drive the NPC's
 * InputState write; queue transitions (replaceJob / clearJob) tell
 * NpcAiSystem to mutate the queue for the next tick.
 */
export interface JobTickAction {
  readonly movementX: number;
  readonly movementY: number;
  readonly actions: number;
  /** Override facing angle. Undefined = NpcAiSystem derives from movement. */
  readonly facing?: number;
  /**
   * Replace `queue.current` with this job. Clears plan. At most one of
   * `replaceJob` / `clearJob` may be set.
   */
  readonly replaceJob?: Job;
  /** Clear `queue.current` so the next tick's fallback generates a new job. */
  readonly clearJob?: boolean;
}

/**
 * Per-tick input into a handler. NpcAiSystem pre-advances the plan and
 * passes the direction vector in; handlers that just follow the plan
 * return { movementX: planDirX, movementY: planDirY, actions: 0 }.
 * Handlers that override (attackTarget stop in range; seekFood consume)
 * replace the direction and/or emit actions / transitions.
 */
export interface JobTickInput {
  readonly ctx: JobContext;
  readonly job: Job;
  readonly plan: NpcPlanData | null;
  /** Normalized direction vector from advancing the plan; zero when no plan. */
  readonly planDirX: number;
  readonly planDirY: number;
}

export interface JobHandler {
  readonly id: string;

  /** Default plan expiry in ticks for this job type. */
  expiryTicks(defaults: GameConfig["npcAiDefaults"]): number;

  /**
   * Build a movement plan for the job. Return null when no movement is
   * required (idle) or when the target can't be resolved.
   */
  plan(ctx: JobContext, job: Job): NpcPlanData | null;

  /**
   * Optional signal to rebuild the plan for reasons other than expiry
   * (e.g., attackTarget drift).
   */
  needsReplan?(ctx: JobContext, job: Job, plan: NpcPlanData): boolean;

  /**
   * Per-tick execution. Produces movement/actions/facing and optional
   * queue transitions.
   */
  tick(input: JobTickInput): JobTickAction;
}
