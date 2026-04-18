/**
 * Tile-scoped event bus.
 *
 * Systems publish events after applyChangeset(). Other systems, NPC sensory input,
 * and the world event bus subscribe to relevant event types.
 *
 * Event types are defined as const symbols alongside their payload interfaces:
 *
 *   export const EntityDied = Symbol("EntityDied");
 *   export interface EntityDiedEvent { entityId: EntityId; killer?: EntityId }
 *
 * subscribe() returns an unsubscribe function.
 *
 * Subscribers are isolated: a thrown error in one handler is logged and the
 * remaining handlers still run. This is critical because the tick loop
 * publishes save / AoI / network events through the same bus — one buggy
 * UI subscriber must not break the whole tick.
 */

// deno-lint-ignore no-explicit-any
type Handler<T = any> = (event: T) => void;

export class EventBus {
  private handlers = new Map<symbol, Set<Handler>>();

  subscribe<T>(type: symbol, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler);
    return () => set!.delete(handler as Handler);
  }

  publish<T>(type: symbol, event: T): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const h of set) {
      try {
        h(event);
      } catch (err) {
        // Identify the event type via its symbol description.
        const name = type.description ?? "<anonymous>";
        console.error(`[EventBus] subscriber threw on "${name}":`, err);
      }
    }
  }

  /** Remove all subscribers. */
  clear(): void {
    this.handlers.clear();
  }
}
