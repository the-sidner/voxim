import type { EventBus } from "@voxim/engine";
import type { EventEmitter } from "./system.ts";

/**
 * Collects publish() calls during system execution and fires them all on the real
 * EventBus only after applyChangeset() — step 4 of the tick sequence.
 *
 * This guarantees event subscribers always observe already-committed world state.
 */
export class DeferredEventQueue implements EventEmitter {
  private queue: Array<{ type: symbol; event: unknown }> = [];

  publish<T>(type: symbol, event: T): void {
    this.queue.push({ type, event });
  }

  /** Fire all queued events on the real bus in order, then clear the queue. */
  flush(bus: EventBus): void {
    for (const { type, event } of this.queue) {
      bus.publish(type, event);
    }
    this.queue = [];
  }

  clear(): void {
    this.queue = [];
  }
}
