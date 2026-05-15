import type { EntityId } from "@voxim/engine";

/**
 * Per-entity state snapshot — the minimum data needed for lag-compensated
 * combat resolution: position for the swept-capsule rewind, facing because
 * directional blocking depends on the defender's facing at the moment of
 * the attack. (Block *state* is no longer snapshotted — it is the
 * current-tick `Blocking` tag now; the action arc dropped the historical
 * CSM/action-bit block resolution, an accepted retune — see T-233.)
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
 * Default capacity 128 = 6.4s at 20Hz — tolerates up to ~3s one-way latency
 * before rewind requests fall off the buffer. `getAt` returns undefined if the
 * requested tick is outside the retained window; callers decide whether to
 * fall back to current state or reject the hit.
 */
export class StateHistoryBuffer {
  private buf: Array<TickSnapshot | undefined>;
  private head = 0;
  private count = 0;

  constructor(capacity = 128) {
    this.buf = new Array(capacity);
  }

  push(snapshot: TickSnapshot): void {
    this.buf[this.head % this.buf.length] = snapshot;
    this.head++;
    if (this.count < this.buf.length) this.count++;
  }

  /**
   * Return the snapshot whose serverTick is closest to the requested tick,
   * but only if that tick falls inside the retained window
   * [oldestTick, newestTick]. Returns undefined otherwise — the caller must
   * handle that path (usually: log once, fall back to current state).
   */
  getAt(serverTick: number): TickSnapshot | undefined {
    if (this.count === 0) return undefined;
    const oldest = this.oldestTick();
    const newest = this.newestTick();
    if (oldest === undefined || newest === undefined) return undefined;
    if (serverTick < oldest || serverTick > newest) return undefined;

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

  /** Oldest retained serverTick, or undefined if empty. */
  oldestTick(): number | undefined {
    if (this.count === 0) return undefined;
    const oldestIdx = (this.head - this.count + this.buf.length) % this.buf.length;
    return this.buf[oldestIdx]?.serverTick;
  }

  /** Newest (most recently pushed) serverTick, or undefined if empty. */
  newestTick(): number | undefined {
    return this.latest()?.serverTick;
  }

  get size(): number {
    return this.count;
  }

  get capacity(): number {
    return this.buf.length;
  }
}
