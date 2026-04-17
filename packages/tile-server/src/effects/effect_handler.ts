/**
 * Effect handler interfaces.
 *
 * Every `effectStat` string referenced from content (concept_verb_matrix.json)
 * must have a registered `EffectApplyHandler`. Tick and compose handlers are
 * optional — not every effect has per-tick side effects or contributes to
 * composed stats.
 *
 * Registered in `server.ts`. Validated at startup against
 * `ContentStore.getAllConceptVerbEntries()` — unknown effectStat = fail fast.
 */
import type { World, EntityId } from "@voxim/engine";
import type { ConceptVerbEntry } from "@voxim/content";
import type { SpatialGrid } from "../spatial_grid.ts";
import type { EventEmitter } from "../system.ts";
import type { ActiveEffect } from "../components/lore_loadout.ts";

// ---- apply ----

export interface EffectApplyContext {
  readonly world: World;
  readonly events: EventEmitter;
  readonly casterId: EntityId;
  readonly casterX: number;
  readonly casterY: number;
  readonly casterZ: number;
  readonly entry: ConceptVerbEntry;
  /** Already scaled: fragment magnitude × outwardScale. */
  readonly magnitude: number;
  readonly currentTick: number;
  readonly spatial: SpatialGrid | null;
  /**
   * When set, entity-targeted effects apply to this id instead of doing their
   * own spatial resolution. Used by ActionSystem strike-verb hits where the
   * melee target is already known.
   */
  readonly overrideTargetId: EntityId | null;
}

export interface EffectApplyHandler {
  readonly id: string;
  apply(ctx: EffectApplyContext): void;
}

// ---- tick (per-entity, per-effect, per-frame side effects) ----

export interface EffectTickContext {
  readonly world: World;
  readonly events: EventEmitter;
  readonly entityId: EntityId;
  readonly effect: ActiveEffect;
  readonly dt: number;
}

export interface EffectTickHandler {
  readonly id: string;
  tick(ctx: EffectTickContext): void;
}

// ---- compose (per-effect contributions to composed stats) ----

export interface EffectContribution {
  /** Multiplicative bonus on movement speed. 0.2 = +20%. */
  speedBonus?: number;
}

export interface EffectComposeHandler {
  readonly id: string;
  contribute(effect: ActiveEffect): EffectContribution;
}
