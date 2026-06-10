/**
 * Skill effect resolvers (T-246) — the five skill effects, folded onto the
 * one action-effect substrate.
 *
 * These were a *parallel* registry (`effects/`, `EffectApplyHandler`) that
 * existed only to serve SkillSystem, with its own caster/magnitude context.
 * They are now ordinary `EffectResolver`s on the action effect registry:
 * the actor is `ctx.entityId`, the per-cast config (`magnitude`,
 * `durationTicks`, `targeting`, `range`, `drainToCaster`, `overrideTargetId`)
 * arrives in `ctx.params`. SkillSystem builds those params from the
 * concept-verb entry today; when a skill becomes an action they come from
 * the action's effect `params` directly — same handlers, no second registry.
 *
 * speed / damage_boost / shield are thin `spawnBuffChild` wrappers (a stat
 * modifier is a buff scene-graph child — the buff primitive). `health` is
 * the targeted heal / drain / DoT (needs the death port → a class resolver).
 * `flee` is the one non-modifier effect (forces NPC job queues).
 *
 * Behaviour is preserved from the retired `effects/skill_effects.ts` /
 * `flee_effect.ts`; only the dispatch shape changed (params vs entry, query
 * targeting vs spatial — bounded entity counts, same as projectile_trace).
 */

import type { World, EntityId } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import { Health, Position } from "../../components/game.ts";
import { NpcJobQueue } from "../../components/npcs.ts";
import type { DeathRequestPort } from "../../events/death.ts";
import { spawnBuffChild } from "./buff.ts";
import type { EffectResolver, ResolveContext } from "../effect.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("skill_effects");

/** damage_boost matrix entries are durationTicks:0 (was consume-on-use). */
const DAMAGE_BOOST_TICKS = 60;

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}
function clamp(lo: number, hi: number, v: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ---- targeting (query-based; bounded entity counts, no spatial dep) -------

function targetsInRange(world: World, casterId: EntityId, cx: number, cy: number, range: number): EntityId[] {
  const rangeSq = range * range;
  const out: EntityId[] = [];
  for (const { entityId, position } of world.query(Position, Health)) {
    if (entityId === casterId) continue;
    const dx = position.x - cx, dy = position.y - cy;
    if (dx * dx + dy * dy <= rangeSq) out.push(entityId);
  }
  return out;
}

function nearestTarget(world: World, casterId: EntityId, cx: number, cy: number, range: number): EntityId | null {
  const rangeSq = range * range;
  let nearest: EntityId | null = null;
  let best = Infinity;
  for (const { entityId, position } of world.query(Position, Health)) {
    if (entityId === casterId) continue;
    const dx = position.x - cx, dy = position.y - cy;
    const d = dx * dx + dy * dy;
    if (d <= rangeSq && d < best) { best = d; nearest = entityId; }
  }
  return nearest;
}

// ---- stat-modifier effects (buff scene-graph children) --------------------

export const speedSkillEffect: EffectResolver = {
  id: "speed",
  resolve(ctx) {
    const mag = num(ctx.params.magnitude);
    spawnBuffChild(ctx.world, ctx.entityId,
      { stat: "moveSpeed", op: "mul", value: 1 + mag, tickDelta: 0 },
      num(ctx.params.durationTicks) || 1);
  },
};

export const damageBoostSkillEffect: EffectResolver = {
  id: "damage_boost",
  resolve(ctx) {
    const mag = num(ctx.params.magnitude);
    const dur = num(ctx.params.durationTicks);
    spawnBuffChild(ctx.world, ctx.entityId,
      { stat: "damageDealt", op: "mul", value: 1 + mag, tickDelta: 0 },
      dur > 0 ? dur : DAMAGE_BOOST_TICKS);
  },
};

export const shieldSkillEffect: EffectResolver = {
  id: "shield",
  resolve(ctx) {
    const mag = num(ctx.params.magnitude);
    // Stronger shield magnitude → more incoming-damage mitigation.
    const factor = clamp(0.2, 0.95, 1 - mag / 100);
    spawnBuffChild(ctx.world, ctx.entityId,
      { stat: "damageTaken", op: "mul", value: factor, tickDelta: 0 },
      num(ctx.params.durationTicks) || 1);
  },
};

// ---- flee (forces NPC job queues; the one non-modifier effect) ------------

export const fleeSkillEffect: EffectResolver = {
  id: "flee",
  resolve(ctx) {
    const { world, entityId, params, serverTick } = ctx;
    const pos = world.get(entityId, Position);
    if (!pos) return;
    const range = num(params.range);
    const rangeSq = range * range;
    const fleeTicks = num(params.durationTicks) > 0 ? num(params.durationTicks) : 60;
    let affected = 0;
    for (const { entityId: targetId, position } of world.query(NpcJobQueue, Position)) {
      const dx = position.x - pos.x, dy = position.y - pos.y;
      if (dx * dx + dy * dy > rangeSq) continue;
      const queue = world.get(targetId, NpcJobQueue)!;
      world.set(targetId, NpcJobQueue, {
        ...queue,
        current: { type: "flee", fromX: pos.x, fromY: pos.y, expiresAt: serverTick + fleeTicks },
      });
      affected++;
    }
    log.debug("fear aura: caster=%s affected=%d npcs for %d ticks", entityId, affected, fleeTicks);
  },
};

// ---- health: targeted heal / drain / DoT (needs the death port) -----------

export class HealthSkillResolver implements EffectResolver {
  readonly id = "health";
  constructor(private readonly deaths: DeathRequestPort) {}

  resolve(ctx: ResolveContext): void {
    const { world, events, entityId, params } = ctx;
    const mag = num(params.magnitude);
    const durationTicks = num(params.durationTicks);
    const targeting = typeof params.targeting === "string" ? params.targeting : "self";
    const range = num(params.range);
    const drainToCaster = params.drainToCaster === true;
    const overrideTargetId = (params.overrideTargetId as EntityId | null | undefined) ?? null;

    if (targeting === "self") {
      if (world.has(entityId, Health)) {
        // Composing mutate (T-249): heals stack with same-tick damage.
        world.mutate(entityId, Health, (h) => ({ ...h, current: Math.min(h.max, h.current + mag) }));
      }
      return;
    }

    const pos = world.get(entityId, Position);
    if (!pos) return;

    const targets = overrideTargetId !== null
      ? [overrideTargetId]
      : targeting === "area"
        ? targetsInRange(world, entityId, pos.x, pos.y, range)
        : (() => { const t = nearestTarget(world, entityId, pos.x, pos.y, range); return t ? [t] : []; })();

    for (const targetId of targets) {
      if (durationTicks > 0) {
        // DoT: a health buff child whose per-tick delta drains the target.
        spawnBuffChild(world, targetId,
          { stat: "health", op: "add", value: 0, tickDelta: -mag }, durationTicks);
        continue;
      }
      const targetHealth = world.get(targetId, Health);
      if (!targetHealth) continue;
      // stolen / death are computed against committed state (this cast's
      // own view); the writes compose with other same-tick contributions
      // (T-249) — a composed-only kill is caught by DeathSystem's sweep.
      const stolen = Math.min(mag, targetHealth.current);
      const next = targetHealth.current - stolen;
      world.mutate(targetId, Health, (h) => ({ ...h, current: Math.max(0, h.current - stolen) }));
      events.publish(TileEvents.DamageDealt, { targetId, sourceId: entityId, amount: stolen, blocked: false });
      if (next <= 0) this.deaths.request({ entityId: targetId, killerId: entityId, cause: "effect" });
      if (drainToCaster && world.has(entityId, Health)) {
        world.mutate(entityId, Health, (h) => ({ ...h, current: Math.min(h.max, h.current + stolen) }));
      }
    }
  }
}
