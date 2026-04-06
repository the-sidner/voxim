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
    this.handlers.get(type)?.forEach((h) => h(event));
  }

  /** Remove all subscribers. */
  clear(): void {
    this.handlers.clear();
  }
}
