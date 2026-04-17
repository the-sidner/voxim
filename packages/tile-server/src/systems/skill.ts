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
import { LoreLoadout } from "../components/lore_loadout.ts";
import type { LoreLoadoutData } from "../components/lore_loadout.ts";
import type { Registry } from "@voxim/engine";
import type { EffectApplyHandler } from "../effects/effect_handler.ts";
import type { DeathRequestPort } from "../events/death.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("SkillSystem");
const SKILL_ACTION_FLAGS = [ACTION_SKILL_1, ACTION_SKILL_2, ACTION_SKILL_3, ACTION_SKILL_4];

export class SkillSystem implements System {
  private currentTick = 0;
  private spatial: SpatialGrid | null = null;

  constructor(
    private readonly content: ContentStore,
    private readonly applyRegistry: Registry<EffectApplyHandler>,
    private readonly deaths: DeathRequestPort,
  ) {}

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

        this.dispatch(world, events, entityId, slot, entry, magnitude, null);
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

    this.dispatch(world, events, casterId, slot, entry, magnitude, targetId);
    return true;
  }

  private dispatch(
    world: World,
    events: EventEmitter,
    casterId: EntityId,
    slot: number,
    entry: ConceptVerbEntry,
    magnitude: number,
    overrideTargetId: EntityId | null,
  ): void {
    const casterPos = world.get(casterId, Position);
    if (!casterPos) return;

    events.publish(TileEvents.SkillActivated, { casterId, slot, effectType: entry.effectType });

    this.applyRegistry.get(entry.effectStat).apply({
      world,
      events,
      casterId,
      casterX: casterPos.x,
      casterY: casterPos.y,
      casterZ: casterPos.z,
      entry,
      magnitude,
      currentTick: this.currentTick,
      spatial: this.spatial,
      overrideTargetId,
      deaths: this.deaths,
    });
  }
}
