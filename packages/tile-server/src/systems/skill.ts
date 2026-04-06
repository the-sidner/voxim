import type { World, EntityId } from "@voxim/engine";
import {
  ACTION_SKILL_1,
  ACTION_SKILL_2,
  ACTION_SKILL_3,
  ACTION_SKILL_4,
  hasAction,
  TileEvents,
} from "@voxim/protocol";
import type { ContentStore, ConceptVerbEntry } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import type { SpatialGrid } from "../spatial_grid.ts";
import { InputState, Health, Stamina, Position } from "../components/game.ts";
import { LoreLoadout, ActiveEffects, CONSUME_ON_USE_SENTINEL } from "../components/lore_loadout.ts";
import type { LoreLoadoutData, ActiveEffect } from "../components/lore_loadout.ts";
import { NpcJobQueue } from "../components/npcs.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("SkillSystem");
const SKILL_ACTION_FLAGS = [ACTION_SKILL_1, ACTION_SKILL_2, ACTION_SKILL_3, ACTION_SKILL_4];

export class SkillSystem implements System {
  private currentTick = 0;
  private spatial: SpatialGrid | null = null;

  constructor(private readonly content: ContentStore) {}

  prepare(serverTick: number, ctx: TickContext): void {
    this.currentTick = serverTick;
    this.spatial = ctx.spatial;
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    for (const { entityId, inputState, loreLoadout } of world.query(InputState, LoreLoadout)) {
      const newCooldowns = loreLoadout.skillCooldowns.map((c) => Math.max(0, c - 1));
      let loadoutDirty = newCooldowns.some((c, i) => c !== loreLoadout.skillCooldowns[i]);

      for (let slot = 0; slot < 4; slot++) {
        if (!hasAction(inputState.actions, SKILL_ACTION_FLAGS[slot])) continue;
        if (newCooldowns[slot] > 0) continue;

        const skillSlot = loreLoadout.skills[slot];
        if (!skillSlot) continue;

        const f1 = this.content.getLoreFragment(skillSlot.outwardFragmentId);
        const f2 = this.content.getLoreFragment(skillSlot.inwardFragmentId);
        if (!f1 || !f2) {
          log.warn("skill slot %d: missing fragment f1=%s f2=%s entity=%s",
            slot, skillSlot.outwardFragmentId, skillSlot.inwardFragmentId, entityId);
          continue;
        }

        const entry = this.content.getConceptVerbEntry(skillSlot.verb, f1.concept, f2.concept);
        if (!entry) {
          log.warn("skill slot %d: no entry for verb=%s outward=%s inward=%s entity=%s",
            slot, skillSlot.verb, f1.concept, f2.concept, entityId);
          continue;
        }

        const staminaCost = entry.staminaCostBase + f2.magnitude * entry.inwardScale;
        const healthCost = entry.healthCostBase;

        const stamina = world.get(entityId, Stamina);
        if (stamina) {
          if (stamina.current < staminaCost) {
            log.debug("skill blocked: entity=%s slot=%d need=%.1f have=%.1f stamina",
              entityId, slot, staminaCost, stamina.current);
            continue;
          }
          const next = Math.max(0, stamina.current - staminaCost);
          world.set(entityId, Stamina, { ...stamina, current: next, exhausted: next <= 0 });
        } else if (staminaCost > 0) {
          continue;
        }

        if (healthCost > 0) {
          const health = world.get(entityId, Health);
          if (!health || health.current <= healthCost) {
            log.debug("skill blocked: entity=%s slot=%d insufficient hp for health cost %.1f", entityId, slot, healthCost);
            continue;
          }
          world.set(entityId, Health, { ...health, current: health.current - healthCost });
        }

        newCooldowns[slot] = entry.cooldownTicks;
        loadoutDirty = true;

        const magnitude = f1.magnitude * entry.outwardScale;
        log.info("skill activated: entity=%s slot=%d verb=%s effect=%s magnitude=%.2f targeting=%s",
          entityId, slot, entry.verb, entry.effectStat, magnitude, entry.targeting);

        applyEffect(world, events, entityId, slot, entry, magnitude, this.currentTick, this.spatial);
      }

      if (loadoutDirty) {
        world.set(entityId, LoreLoadout, {
          ...loreLoadout,
          skillCooldowns: newCooldowns,
        } as LoreLoadoutData);
      }
    }
  }

  /**
   * Resolve a skill from a specific slot on a caster targeting a single entity.
   * Called by ActionSystem when a melee hit connects and pendingSkillVerb === "strike",
   * or by other systems for invoke/ward/step verbs without a swing.
   *
   * Returns false if the skill fizzled (cooldown, insufficient stamina, no entry).
   */
  resolve(
    world: World,
    events: EventEmitter,
    casterId: EntityId,
    slot: number,
    targetId: EntityId | null,
  ): boolean {
    const loreLoadout = world.get(casterId, LoreLoadout);
    if (!loreLoadout) return false;

    const skillSlot = loreLoadout.skills[slot];
    if (!skillSlot) return false;

    const cooldowns = loreLoadout.skillCooldowns;
    if ((cooldowns[slot] ?? 0) > 0) return false;

    const f1 = this.content.getLoreFragment(skillSlot.outwardFragmentId);
    const f2 = this.content.getLoreFragment(skillSlot.inwardFragmentId);
    if (!f1 || !f2) return false;

    const entry = this.content.getConceptVerbEntry(skillSlot.verb, f1.concept, f2.concept);
    if (!entry) return false;

    const staminaCost = entry.staminaCostBase + f2.magnitude * entry.inwardScale;
    const stamina = world.get(casterId, Stamina);
    if (stamina) {
      if (stamina.current < staminaCost) return false;
      const next = Math.max(0, stamina.current - staminaCost);
      world.set(casterId, Stamina, { ...stamina, current: next, exhausted: next <= 0 });
    } else if (staminaCost > 0) {
      return false;
    }

    const healthCost = entry.healthCostBase;
    if (healthCost > 0) {
      const health = world.get(casterId, Health);
      if (!health || health.current <= healthCost) return false;
      world.set(casterId, Health, { ...health, current: health.current - healthCost });
    }

    const newCooldowns = cooldowns.map((c, i) => i === slot ? entry.cooldownTicks : Math.max(0, c - 1));
    world.set(casterId, LoreLoadout, { ...loreLoadout, skillCooldowns: newCooldowns } as LoreLoadoutData);

    const magnitude = f1.magnitude * entry.outwardScale;
    log.info("skill resolved (strike): caster=%s slot=%d effect=%s magnitude=%.2f target=%s",
      casterId, slot, entry.effectStat, magnitude, targetId ?? "none");

    if (targetId) {
      // For strike verb, apply directly to the target instead of targeting logic
      applyEffectToTarget(world, events, casterId, targetId, entry, magnitude, this.currentTick);
    } else {
      applyEffect(world, events, casterId, slot, entry, magnitude, this.currentTick, this.spatial);
    }
    return true;
  }
}

function applyEffect(
  world: World,
  events: EventEmitter,
  casterId: EntityId,
  slot: number,
  entry: ConceptVerbEntry,
  magnitude: number,
  currentTick: number,
  spatial: SpatialGrid | null,
): void {
  const casterPos = world.get(casterId, Position);
  if (!casterPos) return;

  events.publish(TileEvents.SkillActivated, { casterId, slot, effectType: entry.effectType });

  if (entry.effectStat === "flee") {
    const fleeTicks = entry.durationTicks > 0 ? entry.durationTicks : 60;
    const rangeSq = entry.range * entry.range;
    let affected = 0;
    const candidates = spatial
      ? spatial.nearby(casterPos.x, casterPos.y, entry.range)
      : world.query(NpcJobQueue).map((r) => r.entityId);
    for (const targetId of candidates) {
      const npcJobQueue = world.get(targetId, NpcJobQueue);
      if (!npcJobQueue) continue;
      const pos = world.get(targetId, Position);
      if (!pos) continue;
      const dx = pos.x - casterPos.x;
      const dy = pos.y - casterPos.y;
      if (dx * dx + dy * dy > rangeSq) continue;
      world.set(targetId, NpcJobQueue, {
        ...npcJobQueue,
        current: { type: "flee", fromX: casterPos.x, fromY: casterPos.y, expiresAt: currentTick + fleeTicks },
      });
      affected++;
    }
    log.debug("fear aura: caster=%s affected=%d npcs for %d ticks", casterId, affected, fleeTicks);
    return;
  }

  if (entry.targeting === "self") {
    if (entry.effectStat === "health") {
      const health = world.get(casterId, Health);
      if (health) {
        const newHp = Math.min(health.max, health.current + magnitude);
        log.debug("instant heal: entity=%s +%.1f hp (%.1f→%.1f)", casterId, magnitude, health.current, newHp);
        world.set(casterId, Health, { ...health, current: newHp });
      }
    } else {
      const ticksRemaining = entry.effectStat === "damage_boost" ? CONSUME_ON_USE_SENTINEL : entry.durationTicks;
      log.debug("self buff: entity=%s effect=%s magnitude=%.2f ticks=%d",
        casterId, entry.effectStat, magnitude, ticksRemaining);
      addActiveEffect(world, casterId, { effectStat: entry.effectStat, magnitude, ticksRemaining, sourceEntityId: casterId });
    }
    return;
  }

  const targets = entry.targeting === "area"
    ? targetsInRange(world, spatial, casterId, casterPos.x, casterPos.y, entry.range)
    : nearestTarget(world, spatial, casterId, casterPos.x, casterPos.y, entry.range);

  for (const targetId of targets) {
    if (entry.durationTicks > 0) {
      log.debug("dot applied: target=%s effect=%s dps=%.2f ticks=%d", targetId, entry.effectStat, magnitude, entry.durationTicks);
      addActiveEffect(world, targetId, {
        effectStat: entry.effectStat,
        magnitude,
        ticksRemaining: entry.durationTicks,
        sourceEntityId: casterId,
        tickDeltaPerSec: -magnitude,
      });
    } else {
      const targetHealth = world.get(targetId, Health);
      if (!targetHealth) continue;
      const stolen = Math.min(magnitude, targetHealth.current);
      const newTargetHP = targetHealth.current - stolen;
      world.set(targetId, Health, { ...targetHealth, current: newTargetHP });
      events.publish(TileEvents.DamageDealt, { targetId, sourceId: casterId, amount: stolen, blocked: false });
      log.debug("instant damage: caster=%s target=%s dmg=%.1f drain=%s", casterId, targetId, stolen, entry.drainToCaster);
      if (newTargetHP <= 0) {
        world.destroy(targetId);
        events.publish(TileEvents.EntityDied, { entityId: targetId, killerId: casterId });
      }
      if (entry.drainToCaster) {
        const casterHealth = world.get(casterId, Health);
        if (casterHealth) {
          world.set(casterId, Health, { ...casterHealth, current: Math.min(casterHealth.max, casterHealth.current + stolen) });
        }
      }
    }
  }
}

function addActiveEffect(world: World, entityId: EntityId, effect: ActiveEffect): void {
  const current = world.get(entityId, ActiveEffects) ?? { effects: [] };
  world.set(entityId, ActiveEffects, { effects: [...current.effects, effect] });
}

function targetsInRange(world: World, spatial: SpatialGrid | null, casterId: EntityId, cx: number, cy: number, range: number): EntityId[] {
  const rangeSq = range * range;
  const result: EntityId[] = [];
  const candidates = spatial ? spatial.nearby(cx, cy, range) : world.query(Position, Health).map((r) => r.entityId);
  for (const entityId of candidates) {
    if (entityId === casterId) continue;
    if (!world.get(entityId, Health)) continue;
    const pos = world.get(entityId, Position);
    if (!pos) continue;
    const dx = pos.x - cx;
    const dy = pos.y - cy;
    if (dx * dx + dy * dy <= rangeSq) result.push(entityId);
  }
  return result;
}

function nearestTarget(world: World, spatial: SpatialGrid | null, casterId: EntityId, cx: number, cy: number, range: number): EntityId[] {
  const rangeSq = range * range;
  let nearestId: EntityId | null = null;
  let nearestDist = Infinity;
  const candidates = spatial ? spatial.nearby(cx, cy, range) : world.query(Position, Health).map((r) => r.entityId);
  for (const entityId of candidates) {
    if (entityId === casterId) continue;
    if (!world.get(entityId, Health)) continue;
    const pos = world.get(entityId, Position);
    if (!pos) continue;
    const dx = pos.x - cx;
    const dy = pos.y - cy;
    const d = dx * dx + dy * dy;
    if (d <= rangeSq && d < nearestDist) { nearestDist = d; nearestId = entityId; }
  }
  return nearestId ? [nearestId] : [];
}

/**
 * Apply an effect directly to a known target — used by ActionSystem for "strike" verb
 * hits where the target entity is already resolved from the melee hitbox.
 */
function applyEffectToTarget(
  world: World,
  events: EventEmitter,
  casterId: EntityId,
  targetId: EntityId,
  entry: ConceptVerbEntry,
  magnitude: number,
  _currentTick: number,
): void {
  if (entry.durationTicks > 0) {
    addActiveEffect(world, targetId, {
      effectStat: entry.effectStat,
      magnitude,
      ticksRemaining: entry.durationTicks,
      sourceEntityId: casterId,
      tickDeltaPerSec: -magnitude,
    });
    return;
  }

  const targetHealth = world.get(targetId, Health);
  if (!targetHealth) return;
  const stolen = Math.min(magnitude, targetHealth.current);
  const newTargetHP = targetHealth.current - stolen;
  world.set(targetId, Health, { ...targetHealth, current: newTargetHP });
  events.publish(TileEvents.DamageDealt, { targetId, sourceId: casterId, amount: stolen, blocked: false });
  if (newTargetHP <= 0) {
    world.destroy(targetId);
    events.publish(TileEvents.EntityDied, { entityId: targetId, killerId: casterId });
  }
  if (entry.drainToCaster) {
    const casterHealth = world.get(casterId, Health);
    if (casterHealth) {
      world.set(casterId, Health, { ...casterHealth, current: Math.min(casterHealth.max, casterHealth.current + stolen) });
    }
  }
}
