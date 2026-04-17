/**
 * RecipeStepHandler — one handler per Recipe.stepType.
 *
 * `onHit` handlers fire when the workstation is struck by a player (attack,
 * assembly). `onTick` handlers run each tick on every workstation (time).
 * Handlers with no `onHit`/`onTick` for their role are simply skipped by the
 * dispatcher.
 *
 * Each handler encapsulates its full resolution logic (recipe matching, tool
 * checks, active-recipe gating). Shared resolve (consume inputs + spawn
 * output + emit CraftingCompleted) lives in `util.ts`.
 */
import type { World, EntityId } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import type { EventEmitter } from "../system.ts";
import type { HitContext } from "../hit_handler.ts";
import type { WorkstationBufferData } from "../components/building.ts";

export interface RecipeTickContext {
  readonly world: World;
  readonly events: EventEmitter;
  readonly content: ContentStore;
  readonly stationId: EntityId;
  readonly stationType: string;
  readonly buffer: WorkstationBufferData;
}

export interface RecipeHitContext extends RecipeTickContext {
  readonly hit: HitContext;
}

export interface RecipeStepHandler {
  /** Matches Recipe.stepType. Must be unique in the registry. */
  readonly id: string;
  /** Called for every hit on a workstation. Handler decides whether to resolve. */
  onHit?(ctx: RecipeHitContext): void;
  /** Called each tick for every workstation. Handler decides whether to act. */
  onTick?(ctx: RecipeTickContext): void;
}
