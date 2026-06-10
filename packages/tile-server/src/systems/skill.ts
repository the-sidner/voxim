import type { World, EntityId } from "@voxim/engine";
import {
  ACTION_SKILL_1,
  ACTION_SKILL_2,
  ACTION_SKILL_3,
  ACTION_SKILL_4,
  hasAction,
  TileEvents,
} from "@voxim/protocol";
import type { ContentService, ConceptVerbEntry } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { InputState, Health } from "../components/game.ts";
import { LoreLoadout } from "../components/lore_loadout.ts";
import type { LoreLoadoutData } from "../components/lore_loadout.ts";
import type { ActiveActionState } from "../components/action.ts";
import type { EffectRegistry } from "../actions/effect.ts";
import { decrementCooldown, spendStamina, staminaValue } from "../combat/helpers.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("SkillSystem");
const SKILL_ACTION_FLAGS = [ACTION_SKILL_1, ACTION_SKILL_2, ACTION_SKILL_3, ACTION_SKILL_4];

// SkillSystem fires effects outside the phase machine, so it supplies a
// throwaway slot/state/edge — the skill effect resolvers read only
// `entityId` + `params`. The synthetic state goes away when a skill
// becomes an action (then the dispatch is genuinely phase-driven).
const SKILL_DISPATCH_STATE: ActiveActionState = { actionId: "", phase: "", ticksInPhase: 0, initiator: "intent" };

export class SkillSystem implements System {
  /** Reads InputState written by NpcAi via world.write(); must precede. */
  readonly dependsOn = ["NpcAiSystem"];

  private currentTick = 0;

  constructor(
    private readonly content: ContentService,
    private readonly actionEffects: EffectRegistry,
  ) {}


  prepare(serverTick: number, _ctx: TickContext): void {
    this.currentTick = serverTick;
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    const gcdTicks = this.content.getGameConfig().lore.globalCooldownTicks;

    for (const { entityId, inputState, loreLoadout } of world.query(InputState, LoreLoadout)) {
      const newCooldowns = loreLoadout.skillCooldowns.map(decrementCooldown);
      let gcd = decrementCooldown(loreLoadout.globalCooldownTicks);
      let loadoutDirty = gcd !== loreLoadout.globalCooldownTicks
        || newCooldowns.some((c, i) => c !== loreLoadout.skillCooldowns[i]);

      for (let slot = 0; slot < 4; slot++) {
        if (!hasAction(inputState.actions, SKILL_ACTION_FLAGS[slot])) continue;
        if (newCooldowns[slot] > 0) continue; // per-skill cooldown
        if (gcd > 0) continue;                // global cooldown — one cast locks the bar

        const cooldownTicks = this.activateSkill(world, events, entityId, slot, null);
        if (cooldownTicks !== null) {
          newCooldowns[slot] = cooldownTicks;
          gcd = gcdTicks; // any active skill triggers the global cooldown
          loadoutDirty = true;
        }
      }

      if (loadoutDirty) {
        world.set(entityId, LoreLoadout, {
          ...loreLoadout,
          skillCooldowns: newCooldowns,
          globalCooldownTicks: gcd,
        } as LoreLoadoutData);
      }
    }
  }


  /**
   * The single skill-activation path: resolve the slot's fragments → matrix
   * entry, pay the stamina/health cost, and fire the effect. Returns the
   * cooldown ticks to stamp on success, or null if it didn't fire (no slot /
   * fragments / entry, or unaffordable). The caller owns the cooldown
   * bookkeeping — `run` batches all four slots, the strike path stamps one.
   *
   * This is the seam step 2 converts to "start the skill action": the cost
   * becomes the action's `costs`, the cooldown a gate, the dispatch the
   * action's effect on a phase edge.
   */
  private activateSkill(
    world: World,
    events: EventEmitter,
    casterId: EntityId,
    slot: number,
    overrideTargetId: EntityId | null,
  ): number | null {
    const skillSlot = world.get(casterId, LoreLoadout)?.skills[slot];
    if (!skillSlot) return null;

    const f1 = this.content.loreFragments.get(skillSlot.outwardFragmentId);
    const f2 = this.content.loreFragments.get(skillSlot.inwardFragmentId);
    if (!f1 || !f2) {
      log.warn("skill slot %d: missing fragment f1=%s f2=%s entity=%s",
        slot, skillSlot.outwardFragmentId, skillSlot.inwardFragmentId, casterId);
      return null;
    }

    const entry = this.content.getConceptVerbEntry(skillSlot.verb, f1.concept, f2.concept);
    if (!entry) {
      log.warn("skill slot %d: no entry for verb=%s outward=%s inward=%s entity=%s",
        slot, skillSlot.verb, f1.concept, f2.concept, casterId);
      return null;
    }

    const staminaCost = entry.staminaCostBase + f2.magnitude * entry.inwardScale;
    if (!spendStamina(world, casterId, staminaCost)) {
      log.debug("skill blocked: entity=%s slot=%d need=%.1f have=%.1f stamina",
        casterId, slot, staminaCost, staminaValue(world, casterId));
      return null;
    }

    if (entry.healthCostBase > 0) {
      const health = world.get(casterId, Health);
      if (!health || health.current <= entry.healthCostBase) {
        log.debug("skill blocked: entity=%s slot=%d insufficient hp for health cost %.1f",
          casterId, slot, entry.healthCostBase);
        return null;
      }
      const cost = entry.healthCostBase;
      world.mutate(casterId, Health, (h) => ({ ...h, current: Math.max(0, h.current - cost) }));
    }

    const magnitude = f1.magnitude * entry.outwardScale;
    log.info("skill activated: entity=%s slot=%d verb=%s effect=%s magnitude=%.2f target=%s",
      casterId, slot, entry.verb, entry.effectStat, magnitude, overrideTargetId ?? "none");

    this.dispatch(world, events, casterId, slot, entry, magnitude, overrideTargetId);
    return entry.cooldownTicks;
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
    events.publish(TileEvents.SkillActivated, { casterId, slot, effectType: entry.effectType });

    // One effect substrate (T-246): fire through the action-effect registry.
    // The per-cast config the verb-matrix entry carries becomes `params`;
    // the effect's actor is `entityId`. (When a skill becomes an action,
    // these params come straight from the action's effect spec instead.)
    this.actionEffects.get(entry.effectStat).resolve({
      world,
      events,
      entityId: casterId,
      slot: "skill",
      state: SKILL_DISPATCH_STATE,
      content: this.content,
      params: {
        magnitude,
        durationTicks: entry.durationTicks,
        targeting: entry.targeting,
        range: entry.range,
        drainToCaster: entry.drainToCaster ?? false,
        overrideTargetId,
      },
      edge: "enter",
      serverTick: this.currentTick,
    });
  }
}
