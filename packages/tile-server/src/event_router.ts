/**
 * EventRouter — translates internal TileEvents into the GameEvent envelope
 * the client wire protocol carries. Drained once per tick by the tile server
 * and written into each session's BinaryStateMessage. The translation itself
 * is data: each event's bus binding lives on its descriptor in the protocol
 * event registry (T-348), and subscribeAllEvents wires them all in one pass.
 *
 * GateApproached is the one event whose arrival carries a side-effect beyond
 * queueing a GameEvent — it also triggers the cross-tile handoff. That side
 * is injected via the `onGateApproached` hook (a second, explicit subscribe
 * below) so the router stays ignorant of gateway / session management.
 */
import type { EventBus } from "@voxim/engine";
import { TileEvents, subscribeAllEvents } from "@voxim/protocol";
import type { GameEvent, GateApproachedPayload } from "@voxim/protocol";

/** Optional callback fired when a player crosses a gate, after the event is queued for delivery. */
export type GateApproachedHandler = (payload: GateApproachedPayload) => void;

export class EventRouter {
  private readonly pending: GameEvent[] = [];

  constructor(
    private readonly eventBus: EventBus,
    private readonly onGateApproached: GateApproachedHandler | null = null,
  ) {
    this.subscribe();
  }

  /** Return and clear the accumulated events. Called once per tick. */
  drain(): GameEvent[] {
    return this.pending.splice(0);
  }

  /**
   * Push a GameEvent directly without going through the EventBus.
   * Used by tile-server modules that produce events outside the
   * system-event pipeline (e.g. ZoneEnteredEvent from the zone
   * tracker, which doesn't have a TileEvents counterpart).
   */
  push(event: GameEvent): void {
    this.pending.push(event);
  }

  private subscribe(): void {
    // GameEvent translation is registry-driven: every descriptor with a
    // fromTileEvent binding gets its subscribe here (T-348).
    subscribeAllEvents(this.eventBus, (e) => this.pending.push(e));

    // GateApproached additionally kicks off the cross-tile handoff. Registered
    // AFTER subscribeAllEvents so the GameEvent is queued before the handoff
    // fires (EventBus notifies subscribers in registration order), matching
    // the pre-registry behaviour.
    this.eventBus.subscribe(TileEvents.GateApproached, (p: GateApproachedPayload) => {
      this.onGateApproached?.(p);
    });
  }
}
