/**
 * Effect handler interfaces.
 *
 * Every `effectStat` string referenced from content (concept_verb_matrix.json)
 * must have a registered `EffectApplyHandler`. Tick and compose handlers are
 * optional — not every effect has per-tick side effects or contributes to
 * composed stats.
 *
 * Registered in `server.ts`. Validated at startup against
 * `ContentService.getAllConceptVerbEntries()` — unknown effectStat = fail fast.
 */
import type { World, EntityId } from "@voxim/engine";
import type { ConceptVerbEntry } from "@voxim/content";
import type { SpatialGrid } from "../spatial_grid.ts";
import type { EventEmitter } from "../system.ts";
import type { DeathRequestPort } from "../events/death.ts";

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
  readonly deaths: DeathRequestPort;
}

export interface EffectApplyHandler {
  readonly id: string;
  apply(ctx: EffectApplyContext): void;
}

// tick / compose handlers retired (T-239): periodic + stat-modifier
// effects are buff scene-graph children + the `effective()` query.
