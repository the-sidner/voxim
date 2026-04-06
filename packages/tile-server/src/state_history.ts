import type { EntityId } from "@voxim/engine";

/**
 * Per-entity state snapshot — the minimum data needed for lag-compensated combat resolution.
 * Facing angle is included because directional blocking depends on defender facing at
 * the moment of the attack, not at the moment of server processing.
 */
export interface EntitySnapshot {
  entityId: EntityId;
  x: number;
  y: number;
  z: number;
  facing: number; // radians
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  actions: number; // bitfield — for block state at time of hit
}

/** One tick's full snapshot. */
export interface TickSnapshot {
  serverTick: number;
  timestamp: number; // ms, wall clock
  entities: EntitySnapshot[];
}

/**
 * Ring buffer of world snapshots for lag-compensated combat resolution.
 *
 * Stores ~1 second of history at the configured tick rate (default capacity 64 = 3.2s at 20Hz).
 * The combat system rewinds to the tick corresponding to (client send time + estimated RTT)
 * before evaluating attack arc intersection.
 */
export class StateHistoryBuffer {
  private buf: Array<TickSnapshot | undefined>;
  private head = 0;
  private count = 0;

  constructor(capacity = 64) {
    this.buf = new Array(capacity);
  }

  push(snapshot: TickSnapshot): void {
    this.buf[this.head % this.buf.length] = snapshot;
    this.head++;
    if (this.count < this.buf.length) this.count++;
  }

  /**
   * Return the snapshot closest to the given serverTick.
   * Returns undefined if the buffer is empty or the tick is outside the window.
   */
  getAt(serverTick: number): TickSnapshot | undefined {
    let best: TickSnapshot | undefined;
    let bestDelta = Infinity;
    for (const snap of this.buf) {
      if (!snap) continue;
      const delta = Math.abs(snap.serverTick - serverTick);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = snap;
      }
    }
    return best;
  }

  /** Latest snapshot. */
  latest(): TickSnapshot | undefined {
    if (this.count === 0) return undefined;
    return this.buf[(this.head - 1 + this.buf.length) % this.buf.length];
  }

  get size(): number {
    return this.count;
  }
}
