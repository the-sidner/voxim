/**
 * Effect resolver registry (T-226) — the per-phase-transition dispatch.
 *
 * Every `ActionEffect` on an ActionDef names an effect `kind`; the
 * dispatcher fires it on the matching phase edge (`enter` / `exit` /
 * `tick`). Resolvers are registered in code at startup. They are where the
 * imperative work lives (weapon_trace, modify_inventory, set_tag, …) — the
 * dispatcher itself stays content-shaped.
 *
 * Entity-generic by design (load-bearing decision, see
 * ACTION_PRIMITIVE_PLAN.md "The unified substrate"): `ResolveContext`
 * carries an `entityId` and a `slot`, never an "actor". The Resources
 * (T-238) arc dispatches its threshold effects through this same registry.
 */

import type { World, EntityId } from "@voxim/engine";
import { Registry } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import type { ActiveActionState } from "../components/action.ts";
import type { EventEmitter } from "../system.ts";

export type EffectEdge = "enter" | "exit" | "tick";

export interface ResolveContext {
  readonly world: World;
  readonly events: EventEmitter;
  readonly entityId: EntityId;
  /** Slot the action occupies (e.g. "primary", "locomotion"). */
  readonly slot: string;
  /**
   * The action's live state. Mutable `scratch` is the resolver's per-action
   * persistent store (replicated; used by weapon_trace for rewindTick + hit
   * dedup in T-227). Phase / ticksInPhase are read-only to resolvers — the
   * dispatcher owns advancement.
   */
  readonly state: ActiveActionState;
  readonly content: ContentService;
  readonly params: Record<string, unknown>;
  readonly edge: EffectEdge;
}

export interface EffectResolver {
  /** Registry key — the string used in `ActionEffect.kind`. */
  readonly id: string;
  resolve(ctx: ResolveContext): void;
}

export type EffectRegistry = Registry<EffectResolver>;

export function newEffectRegistry(): EffectRegistry {
  return new Registry<EffectResolver>();
}
