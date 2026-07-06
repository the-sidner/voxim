/**
 * Shared types for the entity interaction system.
 */
import type { EntityState } from "../state/client_world.ts";

/**
 * Describes the nearest interactable entity (T-320 proximity selection).
 * Passed to every handler method so handlers can inspect component state
 * without needing a separate world reference.
 */
export interface InteractionTarget {
  readonly entityId: string;
  readonly entityState: EntityState;
  /** 2-D world position (game coords — same as Position component x/y). */
  readonly worldX: number;
  readonly worldY: number;
}

/**
 * One registered handler for an interactable entity category (T-320).
 *
 * Handlers are matched by priority: the highest-priority handler whose
 * canHandle() returns true wins. The InteractionSystem uses this both to
 * select the nearest interactable (a candidate's range = its matching
 * handler's interactionRange) and to activate it (the Use key fires the
 * matching handler's onClick).
 *
 * Register handlers with InteractionSystem.register(). An entity kind with no
 * registered handler is simply never selectable.
 */
export interface EntityInteractionHandler {
  /** Stable identifier used for unregister(). */
  readonly id: string;
  /**
   * Higher priority is checked first — decides which handler owns an entity
   * that matches several, and breaks selection ties at equal distance.
   */
  readonly priority: number;
  /**
   * Maximum world-unit distance at which this entity is selectable / usable.
   * Use Infinity for handlers that should fire at any range.
   */
  readonly interactionRange: number;

  /** Return true when this handler applies to the given entity. */
  canHandle(target: InteractionTarget): boolean;

  /**
   * Called by the Use key when this entity is the selection and within
   * interactionRange. Return true to consume it. Return false (or omit) to
   * let the Use fall through.
   */
  onClick(target: InteractionTarget): boolean;
}
