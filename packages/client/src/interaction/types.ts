/**
 * Shared types for the entity interaction system.
 */
import type { EntityState } from "../state/client_world.ts";

/**
 * Describes the entity currently under the cursor.
 * Passed to every handler method so handlers can inspect component state
 * without needing a separate world reference.
 */
export interface InteractionTarget {
  readonly entityId: string;
  readonly entityState: EntityState;
  /** 2-D world position (game coords — same as Position component x/y). */
  readonly worldX: number;
  readonly worldY: number;
  /** Canvas-relative screen position of the entity origin at pick time. */
  readonly screenX: number;
  readonly screenY: number;
}

/**
 * One registered handler for entity hover and click events.
 *
 * Handlers are matched by priority: the highest-priority handler whose
 * canHandle() returns true wins.  Only one handler fires per event.
 *
 * Register handlers with InteractionSystem.register().  To prevent a handler
 * from ever suppressing normal gameplay (e.g. attacks), simply don't register
 * one for that entity type — the click falls through to the input system.
 */
export interface EntityInteractionHandler {
  /** Stable identifier used for unregister(). */
  readonly id: string;
  /**
   * Higher priority is checked first.  Default handlers use 0; UI handlers
   * that should override combat use positive values (10, 20, …).
   */
  readonly priority: number;
  /**
   * Maximum world-unit distance at which this handler fires on click.
   * Hover highlighting is always shown regardless of distance.
   * Use Infinity for handlers that should fire at any range.
   */
  readonly interactionRange: number;

  /** Return true when this handler applies to the given entity. */
  canHandle(target: InteractionTarget): boolean;

  /** Called once when the cursor enters the entity's pick area. */
  onHoverStart?(target: InteractionTarget): void;
  /** Called once when the cursor leaves the entity's pick area. */
  onHoverEnd?(target: InteractionTarget): void;

  /**
   * Called on LMB click when the entity is within interactionRange.
   * Return true to consume the click (suppresses the attack action).
   * Return false (or omit) to let the click fall through.
   */
  onClick(target: InteractionTarget): boolean;
}
