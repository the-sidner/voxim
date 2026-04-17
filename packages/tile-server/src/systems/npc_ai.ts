import type { World, Registry } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import type { SpatialGrid } from "../spatial_grid.ts";
import { Position, InputState, Health, Hunger, Thirst } from "../components/game.ts";
import { NpcTag, NpcJobQueue } from "../components/npcs.ts";
import type { Job, NpcJobQueueData } from "../components/npcs.ts";
import type { JobHandler, JobContext, NpcTuning } from "../ai/job_handler.ts";
import { advancePlan, findNearestNonNpc, findNearestOther } from "../ai/plan_helpers.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("NpcAiSystem");

/**
 * NpcAiSystem — runs NPCs by dispatching their current job through the
 * `JobHandler` registry.
 *
 * Per tick, per NPC:
 *   1. Emergency overrides (hunger / thirst / flee / aggro) — writes
 *      queue.current directly. (Future: moves into behavior-tree in Phase 4.)
 *   2. If queue.current expired or missing, pop from scheduled or generate
 *      a default idle/wander job.
 *   3. Look up the handler for queue.current.type.
 *   4. Build or rebuild plan if needed (expired, absent, or handler signals).
 *   5. Advance plan → direction vector.
 *   6. Handler.tick(...) → movement / actions / facing / optional transition.
 *   7. Apply transition (replaceJob / clearJob) and write InputState.
 *
 * All job-specific logic lives in handlers; this system never branches on
 * `job.type` beyond the registry lookup.
 */
export class NpcAiSystem implements System {
  private currentTick = 0;
  private spatial: SpatialGrid | null = null;
  private replansRemaining = 0;

  constructor(
    private readonly content: ContentStore,
    private readonly jobs: Registry<JobHandler>,
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
      if (!template) log.warn("no template for npcType=%s entity=%s", npcTag.npcType, entityId);

      const tuning: NpcTuning = {
        wanderRadius:      template?.wanderRadius     ?? defaults.wanderRadius,
        wanderTicks:       template?.wanderTicks      ?? defaults.wanderTicks,
        idleTicks:         template?.idleTicks        ?? defaults.idleTicks,
        attackTicks:       template?.attackTicks      ?? defaults.attackTicks,
        fleeTicks:         template?.fleeTicks        ?? defaults.fleeTicks,
        seekFoodTicks:     template?.seekFoodTicks    ?? defaults.seekFoodTicks,
        attackRangeSq:     template?.attackRange !== undefined
                             ? template.attackRange * template.attackRange
                             : defaults.attackRangeSq,
        aggroRangeSq:      template?.aggroRange !== undefined
                             ? template.aggroRange * template.aggroRange
                             : defaults.defaultAggroRangeSq,
        hungerEmergency:   template?.hungerEmergency  ?? defaults.hungerEmergency,
        thirstEmergency:   template?.thirstEmergency  ?? defaults.thirstEmergency,
        foodHungerRestore: template?.foodHungerRestore ?? defaults.foodHungerRestore,
        waterThirstRestore: template?.waterThirstRestore ?? defaults.waterThirstRestore,
        fleeHealthRatio:   template?.fleeHealthRatio  ?? 0.3,
        behavior:          template?.behavior         ?? "passive",
      };

      let queue: NpcJobQueueData = npcJobQueue;
      let dirty = false;

      // ── 1. Emergency overrides ───────────────────────────────────────────
      if (hunger.value >= tuning.hungerEmergency && queue.current?.type !== "seekFood") {
        log.info("emergency seekFood: entity=%s hunger=%.1f", entityId, hunger.value);
        queue = { current: { type: "seekFood", expiresAt: this.currentTick + tuning.seekFoodTicks }, scheduled: [], plan: null };
        dirty = true;
      } else if (thirst.value >= tuning.thirstEmergency && queue.current?.type !== "seekWater") {
        log.info("emergency seekWater: entity=%s thirst=%.1f", entityId, thirst.value);
        queue = { current: { type: "seekWater", expiresAt: this.currentTick + tuning.seekFoodTicks }, scheduled: [], plan: null };
        dirty = true;
      } else if (tuning.fleeHealthRatio > 0 && health.current < health.max * tuning.fleeHealthRatio && queue.current?.type !== "flee") {
        log.info("emergency flee: entity=%s hp=%.1f/%.1f", entityId, health.current, health.max);
        const threat = findNearestOther(this.spatial!, world, entityId, pos.x, pos.y, defaults.seekScanRadius);
        queue = {
          current: {
            type: "flee",
            fromX: threat?.x ?? pos.x + (Math.random() - 0.5) * 20,
            fromY: threat?.y ?? pos.y + (Math.random() - 0.5) * 20,
            expiresAt: this.currentTick + tuning.fleeTicks,
          },
          scheduled: [], plan: null,
        };
        dirty = true;
      } else if (tuning.behavior === "hostile" && queue.current?.type !== "attackTarget") {
        // Aggro scan — throttled via plan.expiresAt so it doesn't run every tick.
        const scanAllowed = !queue.plan || this.currentTick >= queue.plan.expiresAt;
        if (scanAllowed) {
          const target = findNearestNonNpc(this.spatial!, world, entityId, pos.x, pos.y, tuning.aggroRangeSq);
          if (target) {
            log.info("aggro: entity=%s target=%s", entityId, target.entityId);
            queue = {
              current: { type: "attackTarget", targetId: target.entityId, expiresAt: this.currentTick + tuning.attackTicks },
              scheduled: [], plan: null,
            };
            dirty = true;
          } else {
            // Cooldown so we don't scan every tick when no target exists.
            const cooldownPlan = { steps: [], stepIdx: 0, expiresAt: this.currentTick + defaults.attackPlanExpiryTicks };
            queue = { ...queue, plan: cooldownPlan };
            dirty = true;
          }
        }
      }

      // ── 2. Expire + advance the queue ────────────────────────────────────
      const active = queue.current;
      if (!active || this.currentTick >= active.expiresAt) {
        const next = queue.scheduled.length > 0
          ? queue.scheduled[0]
          : generateDefaultJob(pos.x, pos.y, tuning, this.currentTick);
        log.debug("new job: entity=%s type=%s", entityId, next.type);
        queue = { current: next, scheduled: queue.scheduled.slice(1), plan: null };
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
        template: template ?? null,
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

      // Only persist queue when something actually changed.
      if (dirty) {
        world.set(entityId, NpcJobQueue, { current: queue.current, scheduled: queue.scheduled, plan });
      }
    }
  }
}

/**
 * Default job generator — used when the queue empties and no emergency is
 * active. Stays in NpcAiSystem for Phase 3; Phase 4 behavior trees will
 * supersede this with data-driven default behavior.
 */
function generateDefaultJob(
  px: number,
  py: number,
  tuning: NpcTuning,
  currentTick: number,
): Job {
  if (Math.random() < 0.4) {
    return { type: "idle", expiresAt: currentTick + tuning.idleTicks };
  }
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.random() * tuning.wanderRadius;
  const tx = Math.max(1, Math.min(511, px + Math.cos(angle) * radius));
  const ty = Math.max(1, Math.min(511, py + Math.sin(angle) * radius));
  return { type: "wander", targetX: tx, targetY: ty, expiresAt: currentTick + tuning.wanderTicks };
}
