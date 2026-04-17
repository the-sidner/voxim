import type { World, Registry } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import type { SpatialGrid } from "../spatial_grid.ts";
import { Position, InputState, Health, Hunger, Thirst } from "../components/game.ts";
import { NpcTag, NpcJobQueue } from "../components/npcs.ts";
import type { Job, NpcJobQueueData } from "../components/npcs.ts";
import type { JobHandler, JobContext, NpcTuning } from "../ai/job_handler.ts";
import { advancePlan } from "../ai/plan_helpers.ts";
import type { BTNode, BTContext, BTOutput } from "../ai/bt/mod.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("NpcAiSystem");

/**
 * NpcAiSystem — evaluates each NPC's behavior tree to decide its current
 * job, then dispatches the job through the `JobHandler` registry.
 *
 * Per tick, per NPC:
 *   1. Evaluate the BT referenced by the NPC's template. BT action leaves
 *      populate `BTOutput` (replaceCurrent / cooldownPlan).
 *   2. Apply BTOutput to the queue.
 *   3. Look up the handler for queue.current.type.
 *   4. Build or rebuild plan if expired / missing / handler signals.
 *   5. Advance plan → direction vector.
 *   6. Handler.tick(...) → movement / actions / facing / optional transition.
 *   7. Write InputState.
 *
 * All decision-making lives in BT JSON; all job-specific execution lives in
 * handler files. This system never branches on `job.type` beyond registry
 * lookup and never branches on `behavior`.
 */
export class NpcAiSystem implements System {
  private currentTick = 0;
  private spatial: SpatialGrid | null = null;
  private replansRemaining = 0;

  constructor(
    private readonly content: ContentStore,
    private readonly jobs: Registry<JobHandler>,
    private readonly behaviorTrees: ReadonlyMap<string, BTNode>,
  ) {}

  prepare(serverTick: number, ctx: TickContext): void {
    this.currentTick = serverTick;
    this.spatial = ctx.spatial;
    this.replansRemaining = this.content.getGameConfig().npcAiDefaults.replanBudgetPerTick;
  }

  run(world: World, _events: EventEmitter, _dt: number): void {
    const defaults = this.content.getGameConfig().npcAiDefaults;

    for (const { entityId, npcTag, npcJobQueue, inputState, hunger, thirst, health } of world.query(
      NpcTag, NpcJobQueue, InputState, Hunger, Thirst, Health,
    )) {
      const pos = world.get(entityId, Position);
      if (!pos) continue;

      const template = this.content.getNpcTemplate(npcTag.npcType);
      if (!template) {
        log.warn("no template for npcType=%s entity=%s", npcTag.npcType, entityId);
        continue;
      }

      const bt = this.behaviorTrees.get(template.behaviorTreeId);
      if (!bt) {
        log.warn("no behavior tree id=%s for npcType=%s entity=%s",
          template.behaviorTreeId, npcTag.npcType, entityId);
        continue;
      }

      const tuning: NpcTuning = {
        wanderRadius:       template.wanderRadius     ?? defaults.wanderRadius,
        wanderTicks:        template.wanderTicks      ?? defaults.wanderTicks,
        idleTicks:          template.idleTicks        ?? defaults.idleTicks,
        attackTicks:        template.attackTicks      ?? defaults.attackTicks,
        fleeTicks:          template.fleeTicks        ?? defaults.fleeTicks,
        seekFoodTicks:      template.seekFoodTicks    ?? defaults.seekFoodTicks,
        attackRangeSq:      template.attackRange !== undefined
                              ? template.attackRange * template.attackRange
                              : defaults.attackRangeSq,
        aggroRangeSq:       template.aggroRange !== undefined
                              ? template.aggroRange * template.aggroRange
                              : defaults.defaultAggroRangeSq,
        hungerEmergency:    template.hungerEmergency  ?? defaults.hungerEmergency,
        thirstEmergency:    template.thirstEmergency  ?? defaults.thirstEmergency,
        foodHungerRestore:  template.foodHungerRestore ?? defaults.foodHungerRestore,
        waterThirstRestore: template.waterThirstRestore ?? defaults.waterThirstRestore,
        fleeHealthRatio:    template.fleeHealthRatio,
      };

      let queue: NpcJobQueueData = npcJobQueue;
      let dirty = false;

      // ── 1. Evaluate behavior tree → BTOutput ─────────────────────────────
      const btCtx: BTContext = {
        world, spatial: this.spatial!, content: this.content,
        currentTick: this.currentTick, entityId,
        pos: { x: pos.x, y: pos.y },
        tuning, defaults,
        hunger: hunger.value,
        thirst: thirst.value,
        healthCurrent: health.current,
        healthMax: health.max,
        queue,
      };
      const btOut: BTOutput = {};
      bt.tick(btCtx, btOut);

      // ── 2. Apply BTOutput to queue ───────────────────────────────────────
      if (btOut.replaceCurrent) {
        log.debug("bt emit: entity=%s job=%s", entityId, btOut.replaceCurrent.type);
        queue = { current: btOut.replaceCurrent, scheduled: [], plan: null };
        dirty = true;
      } else if (btOut.cooldownPlan) {
        queue = { ...queue, plan: btOut.cooldownPlan };
        dirty = true;
      }

      // Guard: BT is responsible for populating queue.current; if it didn't
      // (e.g., the "queue_empty_or_expired → set_job_default" branch was
      // skipped because of a tick-local race), keep idle as a safety valve.
      if (!queue.current) {
        queue = { current: { type: "idle", expiresAt: this.currentTick + tuning.idleTicks }, scheduled: [], plan: null };
        dirty = true;
      }

      // ── 3. Dispatch to handler ───────────────────────────────────────────
      const currentJob: Job = queue.current!;
      const handler = this.jobs.get(currentJob.type);

      const jobCtx: JobContext = {
        world, spatial: this.spatial!, content: this.content,
        currentTick: this.currentTick,
        entityId,
        pos: { x: pos.x, y: pos.y },
        template,
        tuning, defaults,
      };

      // ── 4. Plan build / rebuild ──────────────────────────────────────────
      let plan = dirty ? null : queue.plan;
      const needsReplan = !plan
        || this.currentTick >= plan.expiresAt
        || (handler.needsReplan?.(jobCtx, currentJob, plan) ?? false);

      if (needsReplan && this.replansRemaining > 0) {
        plan = handler.plan(jobCtx, currentJob);
        this.replansRemaining--;
        dirty = true;
      }

      // ── 5. Advance plan → direction ──────────────────────────────────────
      let planDirX = 0, planDirY = 0;
      if (plan && plan.steps.length > 0) {
        const result = advancePlan(plan, pos.x, pos.y, defaults.waypointArrivalDistSq);
        if (result.plan.stepIdx !== plan.stepIdx) { dirty = true; }
        plan = result.plan;
        planDirX = result.x;
        planDirY = result.y;
      }

      // ── 6. Handler tick ──────────────────────────────────────────────────
      const action = handler.tick({ ctx: jobCtx, job: currentJob, plan, planDirX, planDirY });

      // ── 7. Apply transition + write InputState ───────────────────────────
      if (action.replaceJob) {
        queue = { current: action.replaceJob, scheduled: queue.scheduled, plan: null };
        plan = null;
        dirty = true;
      } else if (action.clearJob) {
        queue = { current: null, scheduled: [], plan: null };
        plan = null;
        dirty = true;
      }

      const movementX = action.movementX;
      const movementY = action.movementY;
      const actions = action.actions;

      let newFacing: number;
      if (action.facing !== undefined) {
        newFacing = action.facing;
      } else if (movementX !== 0 || movementY !== 0) {
        newFacing = Math.atan2(movementY, movementX);
      } else {
        newFacing = inputState.facing;
      }

      const inputChanged =
        movementX !== inputState.movementX ||
        movementY !== inputState.movementY ||
        actions !== inputState.actions ||
        newFacing !== inputState.facing;

      if (inputChanged) {
        if (movementX !== 0 || movementY !== 0) {
          log.debug("move: entity=%s dir=(%.2f,%.2f) job=%s", entityId, movementX, movementY, currentJob.type);
        }
        if (actions !== 0) {
          log.info("npc action: entity=%s actions=%d facing=%.2f job=%s", entityId, actions, newFacing, currentJob.type);
        }
        world.write(entityId, InputState, {
          ...inputState, movementX, movementY, facing: newFacing, actions,
        });
      }

      if (dirty) {
        world.set(entityId, NpcJobQueue, { current: queue.current, scheduled: queue.scheduled, plan });
      }
    }
  }
}
