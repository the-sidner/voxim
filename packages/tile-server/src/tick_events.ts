/**
 * TickEventBuffer — per-tick one-shot event flags consumed by the CSM.
 *
 * Other systems (ActionSystem, PhysicsSystem, hit handlers) call `fire(entityId, name)`
 * during a tick. CharacterStateMachineSystem reads them when building the SM
 * scope: each registered event becomes a boolean variable (e.g.
 * `event.swing_started`) for one tick, then is cleared.
 *
 * This is the sanctioned channel for "I just did X — let the SM react." It
 * keeps the SM declarative (transitions read events; producers don't call
 * SM-specific APIs) and keeps systems decoupled from layer/state names.
 *
 * The buffer is shared across the tick loop: server.ts owns one instance and
 * injects it into every system that needs to read or write it.
 */

const EMPTY: ReadonlySet<string> = new Set();

export class TickEventBuffer {
  private byEntity = new Map<string, Set<string>>();

  /** Mark an event fired for this entity in the current tick. Idempotent within a tick. */
  fire(entityId: string, eventName: string): void {
    let set = this.byEntity.get(entityId);
    if (!set) {
      set = new Set();
      this.byEntity.set(entityId, set);
    }
    set.add(eventName);
  }

  /** Read events for an entity. Returns an immutable snapshot — do not mutate. */
  get(entityId: string): ReadonlySet<string> {
    return this.byEntity.get(entityId) ?? EMPTY;
  }

  /** Clear all events. Called by CSM tick after consuming. */
  clear(): void {
    this.byEntity.clear();
  }
}
