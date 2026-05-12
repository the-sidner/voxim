/**
 * `applyBuffById` — content-driven buff application (T-196).
 *
 * Bridges a `BuffDef` (declared in `data/buffs/{id}.json`) to the existing
 * ActiveEffects framework: writes an ActiveEffect with the def's effectStat
 * and magnitude, sized by the def's durationSeconds. The same compose / tick
 * handlers that drive lore-matrix effects pick it up automatically — speed
 * slows, health DoTs, etc. work without custom code per buff.
 *
 * Scope: BuffDef covers single-target buffs that translate to one
 * ActiveEffect entry. Area effects (flee aura) and effects that need
 * targeting / range resolution still use the lore matrix's
 * ConceptVerbEntry path through SkillSystem.
 *
 * Discrete-event channel: when `def.onApplyEvent` is set, fires that
 * one-tick event on the target's TickEventBuffer. Lets the CSM react
 * discretely (e.g. `event.stunned` driving a reaction-layer transition)
 * alongside the continuous modifier channel.
 */
import type { World, EntityId } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import type { TickEventBuffer } from "../tick_events.ts";
import { addActiveEffect } from "./util.ts";

/** 20 Hz server tick — one tick = 0.05 seconds. */
const TICKS_PER_SECOND = 20;

/**
 * Apply a content-defined buff to a target.
 *
 * Returns true if the buff was applied, false if the def id was unknown
 * (caller should log; this is a content-authoring bug).
 */
export function applyBuffById(
  world: World,
  content: ContentService,
  tickEvents: TickEventBuffer,
  targetId: EntityId,
  buffDefId: string,
  sourceId: EntityId,
): boolean {
  const def = content.buffs.get(buffDefId);
  if (!def) return false;

  const ticks = Math.max(1, Math.round(def.durationSeconds * TICKS_PER_SECOND));
  addActiveEffect(world, targetId, {
    effectStat: def.effectStat,
    magnitude: def.magnitude,
    ticksRemaining: ticks,
    sourceEntityId: sourceId,
  });

  if (def.onApplyEvent) {
    tickEvents.fire(targetId, def.onApplyEvent);
  }
  return true;
}
