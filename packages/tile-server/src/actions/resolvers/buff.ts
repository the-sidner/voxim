/**
 * Buff resolvers (T-239) — buffs are scene-graph children, not an
 * `ActiveEffects` list.
 *
 *   start_buff — fired by a skill/concept action phase. Spawns a child
 *     entity of `ctx.entityId` carrying a `BuffSpec` (the modifier the
 *     `buffs` ModifierSource reads), the `buff` ambient action (drives
 *     the optional periodic `tickDelta`), and a `buff_timer` Resource
 *     (its lifetime: `cross@0` → `expire_buff` → `destroySubtree`).
 *     A bare entity, not `spawnPrefab` — a buff has no model/physics/
 *     slots, so the actor/visual preamble would be wrong; the buff's
 *     data is its params (still fully data-driven). Honest deviation
 *     from the plan's "buff prefab" wording, recorded in
 *     STATUS_MODIFIER_PLAN.md.
 *
 *   buff_tick — the `buff` action's `hold:tick`. Pure stat-modifier
 *     buffs (`tickDelta === 0`) no-op here; DoT/HoT buffs apply
 *     `tickDelta` to the parent's Health (clamped ≥ 0; the existing
 *     health-zero death path owns lethality).
 */

import { newEntityId } from "@voxim/engine";
import type { World, EntityId } from "@voxim/engine";
import type { EffectResolver } from "../effect.ts";
import { BuffSpec } from "../../components/buff.ts";
import type { BuffSpecData } from "../../components/buff.ts";
import { Resource } from "../../components/resource.ts";
import { ActiveActions } from "../../components/action.ts";
import { Health } from "../../components/game.ts";

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}

/**
 * Spawn a buff as a scene-graph child of `targetId`: a bare entity
 * carrying its `BuffSpec` (read by the `buffs` ModifierSource), the
 * `buff` ambient action (drives the optional periodic `tickDelta`), and
 * a `buff_timer` Resource (its lifetime → `expire_buff` → destroySubtree).
 * The single buff-application path — `start_buff` and the generic skill
 * effect resolvers both go through here. Data-driven: the buff *is* its
 * `spec` + `durationTicks`, no per-buff code.
 */
export function spawnBuffChild(
  world: World,
  targetId: EntityId,
  spec: BuffSpecData,
  durationTicks: number,
): EntityId {
  const ticks = Math.max(1, Math.round(durationTicks));
  const childId = newEntityId();
  world.create(childId);
  world.write(childId, BuffSpec, spec);
  world.write(childId, Resource, {
    values: { buff_timer: { value: ticks, max: ticks } },
  });
  world.write(childId, ActiveActions, {
    states: { buff: { actionId: "buff", phase: "hold", ticksInPhase: 0, initiator: "ambient" } },
  });
  world.setParent(childId, targetId);
  return childId;
}

export const startBuffResolver: EffectResolver = {
  id: "start_buff",
  resolve(ctx) {
    const stat = ctx.params.stat;
    const op = ctx.params.op;
    if (typeof stat !== "string" || (op !== "add" && op !== "mul")) {
      throw new Error(
        `start_buff: params need stat:string + op:"add"|"mul" (got stat=${String(stat)} op=${String(op)})`,
      );
    }
    spawnBuffChild(
      ctx.world,
      ctx.entityId,
      { stat, op, value: num(ctx.params.value), tickDelta: num(ctx.params.tickDelta) },
      num(ctx.params.durationTicks, 1),
    );
  },
};

export const buffTickResolver: EffectResolver = {
  id: "buff_tick",
  resolve(ctx) {
    const spec = ctx.world.get(ctx.entityId, BuffSpec);
    if (!spec || spec.tickDelta === 0) return;
    const parent = ctx.world.getParent(ctx.entityId);
    if (parent === null) return;
    if (!ctx.world.has(parent, Health)) return;
    // Composing mutate (T-249): two DoT buffs on one parent stack.
    const delta = spec.tickDelta;
    ctx.world.mutate(parent, Health, (h) => ({
      ...h,
      current: Math.max(0, Math.min(h.max, h.current + delta)),
    }));
  },
};
