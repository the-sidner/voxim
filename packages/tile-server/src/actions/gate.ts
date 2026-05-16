/**
 * Gate registry (T-226) — the closed-vocabulary typed predicate system.
 *
 * Actions reference gates by name (`ActionGate`) in `preconditions` and
 * `cancel.<phase>.gates`. Each gate is registered in code at startup and
 * evaluated by the ActionDispatcher. There is no expression DSL: a condition
 * the vocabulary can't express is a new registered gate, not inline logic.
 *
 * Entity-generic by design (load-bearing decision, see
 * ACTION_PRIMITIVE_PLAN.md "The unified substrate"): `GateContext` carries an
 * `entityId`, never an "actor". The Resources (T-238) and Status/Modifier
 * (T-239) arcs reuse this exact registry doctrine rather than inventing
 * parallel predicate systems.
 */

import type { World, EntityId } from "@voxim/engine";
import { Registry } from "@voxim/engine";
import type { ContentService } from "@voxim/content";

export interface GateContext {
  readonly world: World;
  readonly entityId: EntityId;
  readonly content: ContentService;
  /** The gate's typed payload from the ActionGate JSON (`params`). */
  readonly params: Record<string, unknown>;
}

export interface GateHandler {
  /** Registry key — the string used in `ActionGate.gate`. */
  readonly id: string;
  /** True ⇒ the gate passes. Pure: no world mutation. */
  test(ctx: GateContext): boolean;
}

export type GateRegistry = Registry<GateHandler>;

export function newGateRegistry(): GateRegistry {
  return new Registry<GateHandler>();
}
