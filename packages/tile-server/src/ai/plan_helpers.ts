/**
 * Shared AI helpers — used by NpcAiSystem and JobHandlers.
 *
 * Pure geometry / spatial query utilities: movement step generation, plan
 * advancement, and spatial scans. No job-specific logic.
 */
import type { World, EntityId } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import type { SpatialGrid } from "../spatial_grid.ts";
import type { PlanStep, NpcPlanData } from "../components/npcs.ts";
import { Position, Health } from "../components/game.ts";
import { NpcTag } from "../components/npcs.ts";
import { ItemData } from "../components/items.ts";
import { NoiseLevel } from "../components/noise.ts";

/**
 * Build a sequence of moveTo steps along a straight line from start to end,
 * spaced `waypointSpacing` apart. Always ends exactly at the destination.
 */
export function moveSteps(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  waypointSpacing: number,
): PlanStep[] {
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
 * Advance through the plan's steps from (px, py). Skips moveTo steps whose
 * arrival threshold is met; returns the normalized direction vector toward
 * the next unmet step, and the advanced plan state.
 */
export function advancePlan(
  plan: NpcPlanData,
  px: number,
  py: number,
  waypointArrivalDistSq: number,
): { plan: NpcPlanData; x: number; y: number } {
  let idx = plan.stepIdx;
  const steps = plan.steps;

  while (idx < steps.length) {
    const step = steps[idx];
    if (step.kind !== "moveTo") break;
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

  // Future step kinds (interact/wait/dropItem) — advance past them until
  // their own execution logic is wired in.
  return { plan: { ...plan, stepIdx: idx + 1 }, x: 0, y: 0 };
}

// ---- spatial query helpers ----

export function findNearestNonNpc(
  spatial: SpatialGrid,
  world: World,
  selfId: EntityId,
  px: number,
  py: number,
  maxDistSq: number,
): { entityId: EntityId } | null {
  const candidates = spatial.nearby(px, py, Math.sqrt(maxDistSq));
  let best: { entityId: EntityId } | null = null;
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

/**
 * Nearest *other* NPC within `maxDistSq` (excludes self and non-NPCs). Drives
 * social-idle clustering (T-043): an idle NPC drifts toward a neighbour so a
 * cluster forms and reads as socialising rather than milling at random.
 */
export function findNearestNpc(
  spatial: SpatialGrid,
  world: World,
  selfId: EntityId,
  px: number,
  py: number,
  maxDistSq: number,
): EntityId | null {
  const candidates = spatial.nearby(px, py, Math.sqrt(maxDistSq));
  let best: EntityId | null = null;
  let bestDistSq = maxDistSq;
  for (const entityId of candidates) {
    if (entityId === selfId) continue;
    if (!world.get(entityId, NpcTag)) continue;
    const pos = world.get(entityId, Position);
    if (!pos) continue;
    const dx = pos.x - px; const dy = pos.y - py;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) { bestDistSq = dSq; best = entityId; }
  }
  return best;
}

/**
 * Unified NPC threat detection (T-016 visual + T-014 auditory = T-015). A target
 * within `aggroRangeSq` is detected if ANY sense fires:
 *   - **sight**  — inside the forward cone (`facing` ± `coneHalfAngle`); full range.
 *   - **hearing** — `noise × proximity ≥ auditoryThreshold`, where proximity is
 *     `1 − dist/range`. Omnidirectional: a sprinter behind is heard, a croucher
 *     at range is not. (`noise` is the target's `NoiseLevel`, 0 if absent.)
 *   - **proximity** — anything within the short `rearRangeSq`, any direction,
 *     any noise (you feel a presence at your back).
 * Among detected targets the nearest wins. So a frontal approach is always
 * caught, flanking a quiet crouching attacker is viable, and running up behind
 * an NPC still alerts it.
 */
export function findDetectedThreat(
  spatial: SpatialGrid,
  world: World,
  selfId: EntityId,
  px: number,
  py: number,
  facing: number,
  aggroRangeSq: number,
  coneHalfAngle: number,
  rearRangeSq: number,
  auditoryThreshold: number,
): { entityId: EntityId } | null {
  const range = Math.sqrt(aggroRangeSq);
  const candidates = spatial.nearby(px, py, range);
  let best: { entityId: EntityId } | null = null;
  let bestDistSq = aggroRangeSq;
  for (const entityId of candidates) {
    if (entityId === selfId) continue;
    if (world.get(entityId, NpcTag)) continue;
    if (!world.get(entityId, Health)) continue;
    const pos = world.get(entityId, Position)!;
    const dx = pos.x - px; const dy = pos.y - py;
    const dSq = dx * dx + dy * dy;
    if (dSq > aggroRangeSq) continue; // hard outer cap: nothing detected past aggro range

    const off = Math.abs(Math.atan2(Math.sin(Math.atan2(dy, dx) - facing), Math.cos(Math.atan2(dy, dx) - facing)));
    const sight = off <= coneHalfAngle;
    const felt = dSq <= rearRangeSq;
    const noise = world.get(entityId, NoiseLevel)?.level ?? 0;
    const heard = noise * (1 - Math.sqrt(dSq) / range) >= auditoryThreshold;

    if (!(sight || felt || heard)) continue;
    if (dSq < bestDistSq) { bestDistSq = dSq; best = { entityId }; }
  }
  return best;
}

export function findNearestOther(
  spatial: SpatialGrid,
  world: World,
  selfId: EntityId,
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

export function findNearestConsumable(
  spatial: SpatialGrid,
  world: World,
  px: number,
  py: number,
  content: ContentService,
  kind: "food" | "water",
  scanRadius: number,
): { entityId: EntityId; x: number; y: number } | null {
  const candidates = spatial.nearby(px, py, scanRadius);
  let best: { entityId: EntityId; x: number; y: number } | null = null;
  let bestDistSq = Infinity;
  for (const entityId of candidates) {
    const itemData = world.get(entityId, ItemData);
    if (!itemData) continue;
    const stats = content.deriveItemStats(itemData.prefabId);
    const value = kind === "food" ? (stats.foodValue ?? 0) : (stats.waterValue ?? 0);
    if (value <= 0) continue;
    const pos = world.get(entityId, Position)!;
    const dx = pos.x - px; const dy = pos.y - py;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) { bestDistSq = dSq; best = { entityId, x: pos.x, y: pos.y }; }
  }
  return best;
}
