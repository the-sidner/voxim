import type { World } from "@voxim/engine";
import { ACTION_USE_SKILL } from "@voxim/protocol";
import type { ContentStore, GameConfig } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import type { SpatialGrid } from "../spatial_grid.ts";
import { Position, InputState, Health, Hunger, Thirst } from "../components/game.ts";
import { NpcTag, NpcJobQueue } from "../components/npcs.ts";
import type { Job, NpcJobQueueData, NpcPlanData, PlanStep } from "../components/npcs.ts";
import { ItemData } from "../components/items.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("NpcAiSystem");

export class NpcAiSystem implements System {
  private currentTick = 0;
  private spatial: SpatialGrid | null = null;
  private replansRemaining = 0;

  constructor(private readonly content: ContentStore) {}

  prepare(serverTick: number, ctx: TickContext): void {
    this.currentTick = serverTick;
    this.spatial = ctx.spatial;
    this.replansRemaining = this.content.getGameConfig().npcAiDefaults.replanBudgetPerTick;
  }

  run(world: World, _events: EventEmitter, _dt: number): void {

    const defaults = this.content.getGameConfig().npcAiDefaults;

    for (const { entityId, npcTag, npcJobQueue, inputState, hunger, thirst, health } of world.query(
      NpcTag,
      NpcJobQueue,
      InputState,
      Hunger,
      Thirst,
      Health,
    )) {
      const pos = world.get(entityId, Position);
      if (!pos) continue;

      const template = this.content.getNpcTemplate(npcTag.npcType);
      if (!template) log.warn("no template for npcType=%s entity=%s", npcTag.npcType, entityId);

      const fleeRatio      = template?.fleeHealthRatio ?? 0.3;
      const behavior       = template?.behavior ?? "passive";
      const wanderRadius   = template?.wanderRadius ?? defaults.wanderRadius;
      const wanderTicks    = template?.wanderTicks ?? defaults.wanderTicks;
      const idleTicks      = template?.idleTicks ?? defaults.idleTicks;
      const attackTicks    = template?.attackTicks ?? defaults.attackTicks;
      const fleeTicks      = template?.fleeTicks ?? defaults.fleeTicks;
      const seekFoodTicks  = template?.seekFoodTicks ?? defaults.seekFoodTicks;
      const aggroRangeSq   = template?.aggroRange !== undefined
        ? template.aggroRange * template.aggroRange
        : defaults.defaultAggroRangeSq;
      const attackRangeSq  = template?.attackRange !== undefined
        ? template.attackRange * template.attackRange
        : defaults.attackRangeSq;
      const hungerEmergency  = template?.hungerEmergency ?? defaults.hungerEmergency;
      const thirstEmergency  = template?.thirstEmergency ?? defaults.thirstEmergency;
      const foodHungerRestore = template?.foodHungerRestore ?? defaults.foodHungerRestore;
      const waterThirstRestore = template?.waterThirstRestore ?? defaults.waterThirstRestore;

      let queue: NpcJobQueueData = npcJobQueue;
      let dirty = false;

      // ── Emergency overrides ───────────────────────────────────────────────
      if (hunger.value >= hungerEmergency && queue.current?.type !== "seekFood") {
        log.info("emergency seekFood: entity=%s hunger=%.1f", entityId, hunger.value);
        queue = { current: { type: "seekFood", expiresAt: this.currentTick + seekFoodTicks }, scheduled: [], plan: null };
        dirty = true;
      } else if (thirst.value >= thirstEmergency && queue.current?.type !== "seekWater") {
        log.info("emergency seekWater: entity=%s thirst=%.1f", entityId, thirst.value);
        queue = { current: { type: "seekWater", expiresAt: this.currentTick + seekFoodTicks }, scheduled: [], plan: null };
        dirty = true;
      } else if (fleeRatio > 0 && health.current < health.max * fleeRatio && queue.current?.type !== "flee") {
        log.info("emergency flee: entity=%s hp=%.1f/%.1f", entityId, health.current, health.max);
        const threat = findNearestOther(this.spatial!, world, entityId, pos.x, pos.y, defaults.seekScanRadius);
        queue = {
          current: {
            type: "flee",
            fromX: threat?.x ?? pos.x + (Math.random() - 0.5) * 20,
            fromY: threat?.y ?? pos.y + (Math.random() - 0.5) * 20,
            expiresAt: this.currentTick + fleeTicks,
          },
          scheduled: [],
          plan: null,
        };
        dirty = true;
      } else if (behavior === "hostile" && queue.current?.type !== "attackTarget") {
        // Aggro scan — only runs when NPC does NOT already have an attack job.
        // The plan's expiresAt throttles how often this can fire.
        const scanAllowed = !queue.plan || this.currentTick >= queue.plan.expiresAt;
        if (scanAllowed) {
          const target = findNearestNonNpc(this.spatial!, world, entityId, pos.x, pos.y, aggroRangeSq);
          if (target) {
            log.info("aggro: entity=%s target=%s", entityId, target.entityId);
            queue = {
              current: { type: "attackTarget", targetId: target.entityId, expiresAt: this.currentTick + attackTicks },
              scheduled: [],
              plan: null,
            };
            dirty = true;
          } else {
            // No target found — set a cooldown so we don't scan every tick.
            const cooldownPlan = { steps: [], stepIdx: 0, expiresAt: this.currentTick + defaults.attackPlanExpiryTicks };
            queue = { ...queue, plan: cooldownPlan };
            dirty = true;
          }
        }
      }

      // ── Validate attackTarget — clear if target gone ───────────────────────
      if (queue.current?.type === "attackTarget") {
        if (!world.isAlive(queue.current.targetId)) {
          queue = { current: null, scheduled: [], plan: null };
          dirty = true;
        }
      }

      // ── Job expiry / advance ──────────────────────────────────────────────
      const job = queue.current;
      if (!job || this.currentTick >= job.expiresAt) {
        const next = queue.scheduled.length > 0
          ? queue.scheduled[0]
          : generateDefaultJob(pos.x, pos.y, wanderRadius, wanderTicks, idleTicks, this.currentTick);
        log.debug("new job: entity=%s type=%s", entityId, next.type);
        queue = { current: next, scheduled: queue.scheduled.slice(1), plan: null };
        dirty = true;
      }

      // ── Food / water item pickup ──────────────────────────────────────────
      const activeJob = queue.current!;
      if (activeJob.type === "seekFood") {
        const food = findNearestConsumable(this.spatial!, world, pos.x, pos.y, this.content, "food", defaults.seekScanRadius);
        if (food) {
          const dx = food.x - pos.x;
          const dy = food.y - pos.y;
          if (dx * dx + dy * dy <= defaults.foodPickupRangeSq) {
            world.set(entityId, Hunger, { value: Math.max(0, hunger.value - foodHungerRestore) });
            world.destroy(food.entityId);
            queue = { current: { type: "idle", expiresAt: this.currentTick + 20 }, scheduled: queue.scheduled, plan: null };
            dirty = true;
          }
        }
      } else if (activeJob.type === "seekWater") {
        const water = findNearestConsumable(this.spatial!, world, pos.x, pos.y, this.content, "water", defaults.seekScanRadius);
        if (water) {
          const dx = water.x - pos.x;
          const dy = water.y - pos.y;
          if (dx * dx + dy * dy <= defaults.foodPickupRangeSq) {
            world.set(entityId, Thirst, { value: Math.max(0, thirst.value - waterThirstRestore) });
            world.destroy(water.entityId);
            queue = { current: { type: "idle", expiresAt: this.currentTick + 20 }, scheduled: queue.scheduled, plan: null };
            dirty = true;
          }
        }
      }

      // ── Planning ──────────────────────────────────────────────────────────
      const currentJob = queue.current!;
      let plan = dirty ? null : queue.plan;

      if (currentJob.type !== "idle") {
        const needsReplan = !plan
          || this.currentTick >= plan.expiresAt
          || (currentJob.type === "attackTarget" && targetDrifted(world, currentJob.targetId, plan, defaults.attackReplanDistSq));

        if (needsReplan && this.replansRemaining > 0) {
          plan = buildPlan(currentJob, pos.x, pos.y, world, this.content, this.currentTick, this.spatial!, attackRangeSq, defaults);
          this.replansRemaining--;
          dirty = true;
        }
      } else {
        if (plan !== null) { plan = null; dirty = true; }
      }

      // ── Execution ─────────────────────────────────────────────────────────
      let movementX = 0;
      let movementY = 0;

      if (plan && plan.steps.length > 0) {
        const result = advancePlan(plan, pos.x, pos.y, defaults.waypointArrivalDistSq);
        if (result.plan.stepIdx !== plan.stepIdx) { plan = result.plan; dirty = true; }
        else { plan = result.plan; }
        movementX = result.x;
        movementY = result.y;

        if (currentJob.type === "attackTarget") {
          const targetPos = world.get(currentJob.targetId, Position);
          if (targetPos) {
            const dx = targetPos.x - pos.x;
            const dy = targetPos.y - pos.y;
            if (dx * dx + dy * dy <= attackRangeSq) {
              movementX = 0;
              movementY = 0;
            }
          }
        }
      }

      // ── Attack action ─────────────────────────────────────────────────────
      const actions = currentJob.type === "attackTarget"
        ? resolveAttackAction(world, currentJob.targetId, pos.x, pos.y, attackRangeSq)
        : 0;

      // When stopped to attack, face toward target instead of keeping last movement direction.
      let newFacing: number;
      if (movementX !== 0 || movementY !== 0) {
        newFacing = Math.atan2(movementY, movementX);
      } else if (currentJob.type === "attackTarget") {
        const targetPos = world.get(currentJob.targetId, Position);
        if (targetPos) {
          newFacing = Math.atan2(targetPos.y - pos.y, targetPos.x - pos.x);
        } else {
          newFacing = inputState.facing;
        }
      } else {
        newFacing = inputState.facing;
      }

      const inputChanged = movementX !== inputState.movementX ||
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

      // Only persist queue when something actually changed — avoids 264 writes/tick
      // for NPCs that are just executing an existing plan.
      if (dirty) {
        world.set(entityId, NpcJobQueue, { current: queue.current, scheduled: queue.scheduled, plan });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Build a movement plan for the given job starting at (px, py).
 * Returns null for jobs that require no movement (idle).
 */
function buildPlan(
  job: Job,
  px: number,
  py: number,
  world: World,
  content: ContentStore,
  currentTick: number,
  spatial: SpatialGrid,
  attackRangeSq: number,
  defaults: GameConfig["npcAiDefaults"],
): NpcPlanData | null {
  switch (job.type) {
    case "idle":
      return null;

    case "wander":
      return {
        steps: moveSteps(px, py, job.targetX, job.targetY, defaults.waypointSpacing),
        stepIdx: 0,
        expiresAt: currentTick + defaults.planExpiryTicks,
      };

    case "attackTarget": {
      const targetPos = world.get(job.targetId, Position);
      if (!targetPos) return null;
      // Each wolf approaches from its own current angle toward the target,
      // stopping just outside melee range. This naturally spreads a pack
      // around the target instead of stacking them all on the same point.
      const APPROACH_RADIUS = Math.sqrt(attackRangeSq) * 0.85;
      const dx0 = px - targetPos.x;
      const dy0 = py - targetPos.y;
      const dist0 = Math.sqrt(dx0 * dx0 + dy0 * dy0) || 1;
      const destX = targetPos.x + (dx0 / dist0) * APPROACH_RADIUS;
      const destY = targetPos.y + (dy0 / dist0) * APPROACH_RADIUS;
      return {
        steps: moveSteps(px, py, destX, destY, defaults.waypointSpacing),
        stepIdx: 0,
        expiresAt: currentTick + defaults.attackPlanExpiryTicks,
        lastKnownTargetX: targetPos.x,
        lastKnownTargetY: targetPos.y,
      };
    }

    case "flee": {
      const dx = px - job.fromX;
      const dy = py - job.fromY;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const fleeX = Math.max(1, Math.min(511, px + (dx / dist) * 24));
      const fleeY = Math.max(1, Math.min(511, py + (dy / dist) * 24));
      return {
        steps: moveSteps(px, py, fleeX, fleeY, defaults.waypointSpacing),
        stepIdx: 0,
        expiresAt: currentTick + defaults.planExpiryTicks,
      };
    }

    case "seekFood":
    case "seekWater": {
      const kind = job.type === "seekFood" ? "food" : "water";
      const target = findNearestConsumable(spatial, world, px, py, content, kind, defaults.seekScanRadius);
      if (!target) {
        const angle = Math.random() * Math.PI * 2;
        return {
          steps: moveSteps(px, py, px + Math.cos(angle) * 20, py + Math.sin(angle) * 20, defaults.waypointSpacing),
          stepIdx: 0,
          expiresAt: currentTick + defaults.planExpiryTicks,
        };
      }
      return {
        steps: moveSteps(px, py, target.x, target.y, defaults.waypointSpacing),
        stepIdx: 0,
        expiresAt: currentTick + defaults.planExpiryTicks,
      };
    }
  }
}

/**
 * Build a sequence of moveTo steps along a straight line from start to end,
 * spaced `waypointSpacing` apart. Always ends exactly at the destination.
 */
function moveSteps(startX: number, startY: number, endX: number, endY: number, waypointSpacing: number): PlanStep[] {
  const dx = endX - startX;
  const dy = endY - startY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < waypointSpacing) {
    return [{ kind: "moveTo", x: endX, y: endY }];
  }
  const count = Math.floor(dist / waypointSpacing);
  const steps: PlanStep[] = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    steps.push({ kind: "moveTo", x: startX + dx * t, y: startY + dy * t });
  }
  steps[steps.length - 1] = { kind: "moveTo", x: endX, y: endY };
  return steps;
}

/**
 * Returns true if the attack target has drifted far enough from the plan's
 * last known position to warrant rebuilding the path.
 */
function targetDrifted(world: World, targetId: string, plan: NpcPlanData, attackReplanDistSq: number): boolean {
  if (plan.lastKnownTargetX === undefined) return false;
  const targetPos = world.get(targetId, Position);
  if (!targetPos) return false;
  const dx = targetPos.x - plan.lastKnownTargetX;
  const dy = targetPos.y - (plan.lastKnownTargetY ?? 0);
  return dx * dx + dy * dy > attackReplanDistSq;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Advance through the plan's steps from the NPC's current position.
 * Handles moveTo steps now; other step kinds (interact, wait, dropItem) will
 * be dispatched here when implemented.
 * Pure math for moveTo — no world queries.
 */
function advancePlan(
  plan: NpcPlanData,
  px: number,
  py: number,
  waypointArrivalDistSq: number,
): { plan: NpcPlanData; x: number; y: number } {
  let idx = plan.stepIdx;
  const steps = plan.steps;

  // Skip moveTo steps already reached
  while (idx < steps.length) {
    const step = steps[idx];
    if (step.kind !== "moveTo") break; // non-movement steps are handled below
    const dx = step.x - px;
    const dy = step.y - py;
    if (dx * dx + dy * dy > waypointArrivalDistSq) break;
    idx++;
  }

  if (idx >= steps.length) {
    return { plan: { ...plan, stepIdx: idx }, x: 0, y: 0 };
  }

  const step = steps[idx];

  if (step.kind === "moveTo") {
    const dx = step.x - px;
    const dy = step.y - py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return { plan: { ...plan, stepIdx: idx }, x: dx / dist, y: dy / dist };
  }

  // Future step kinds: interact, wait, dropItem — advance past them immediately
  // until their own execution logic is wired in.
  return { plan: { ...plan, stepIdx: idx + 1 }, x: 0, y: 0 };
}

// ---------------------------------------------------------------------------
// Attack resolution
// ---------------------------------------------------------------------------

function resolveAttackAction(
  world: World,
  targetId: string,
  px: number,
  py: number,
  attackRangeSq: number,
): number {
  const targetPos = world.get(targetId, Position);
  if (!targetPos) return 0;
  const dx = targetPos.x - px;
  const dy = targetPos.y - py;
  return dx * dx + dy * dy <= attackRangeSq ? ACTION_USE_SKILL : 0;
}

// ---------------------------------------------------------------------------
// Spatial query helpers — use SpatialGrid for O(cells) instead of O(entities)
// ---------------------------------------------------------------------------

function findNearestNonNpc(
  spatial: SpatialGrid,
  world: World,
  selfId: string,
  px: number,
  py: number,
  maxDistSq: number,
): { entityId: string } | null {
  const candidates = spatial.nearby(px, py, Math.sqrt(maxDistSq));
  let best: { entityId: string } | null = null;
  let bestDistSq = maxDistSq;
  for (const entityId of candidates) {
    if (entityId === selfId) continue;
    if (world.get(entityId, NpcTag)) continue;
    if (!world.get(entityId, Health)) continue;
    const pos = world.get(entityId, Position)!;
    const dx = pos.x - px; const dy = pos.y - py;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) { bestDistSq = dSq; best = { entityId }; }
  }
  return best;
}

function findNearestOther(
  spatial: SpatialGrid,
  world: World,
  selfId: string,
  px: number,
  py: number,
  scanRadius: number,
): { x: number; y: number } | null {
  const candidates = spatial.nearby(px, py, scanRadius);
  let best: { x: number; y: number } | null = null;
  let bestDistSq = Infinity;
  for (const entityId of candidates) {
    if (entityId === selfId) continue;
    const pos = world.get(entityId, Position)!;
    const dx = pos.x - px; const dy = pos.y - py;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) { bestDistSq = dSq; best = { x: pos.x, y: pos.y }; }
  }
  return best;
}

function findNearestConsumable(
  spatial: SpatialGrid,
  world: World,
  px: number,
  py: number,
  content: ContentStore,
  kind: "food" | "water",
  scanRadius: number,
): { entityId: string; x: number; y: number } | null {
  const candidates = spatial.nearby(px, py, scanRadius);
  let best: { entityId: string; x: number; y: number } | null = null;
  let bestDistSq = Infinity;
  for (const entityId of candidates) {
    const itemData = world.get(entityId, ItemData);
    if (!itemData) continue;
    const stats = content.deriveItemStats(itemData.itemType);
    const value = kind === "food" ? (stats.foodValue ?? 0) : (stats.waterValue ?? 0);
    if (value <= 0) continue;
    const pos = world.get(entityId, Position)!;
    const dx = pos.x - px; const dy = pos.y - py;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) { bestDistSq = dSq; best = { entityId, x: pos.x, y: pos.y }; }
  }
  return best;
}

function generateDefaultJob(
  px: number,
  py: number,
  wanderRadius: number,
  wanderTicks: number,
  idleTicks: number,
  currentTick = 0,
): Job {
  if (Math.random() < 0.4) {
    return { type: "idle", expiresAt: currentTick + idleTicks };
  }
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.random() * wanderRadius;
  const tx = Math.max(1, Math.min(511, px + Math.cos(angle) * radius));
  const ty = Math.max(1, Math.min(511, py + Math.sin(angle) * radius));
  return { type: "wander", targetX: tx, targetY: ty, expiresAt: currentTick + wanderTicks };
}
