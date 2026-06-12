/**
 * Input sanitation + merge (T-253) — the pure half of the tick loop's
 * input drain, extracted so hostile-client handling is testable.
 *
 * A client controls every byte of a MovementDatagram, so nothing here is
 * trusted:
 *   - Non-finite movement/facing would poison Position via stepPhysics and
 *     then spread to every nearby entity through the pairwise-separation
 *     pass (and onto the wire, and into the lag-comp history). Non-finite
 *     numeric fields are zeroed.
 *   - Datagrams are unreliable AND unordered: an old datagram arriving
 *     late must not regress the applied input or the ack
 *     (`ackInputSeq` ← InputState.seq). Anything with seq ≤ the last
 *     applied seq is discarded, and "latest" is chosen by seq, not by
 *     arrival order.
 *   - One-shot action bits OR across the batch (a click in any frame
 *     counts); held bits come from the latest frame only (releasing a key
 *     before tick end must not read as still held).
 */

import type { MovementDatagram } from "@voxim/protocol";

export interface MergedInput {
  /** The (sanitized) highest-seq datagram of the batch. */
  latest: MovementDatagram;
  /** One-shot bits OR'd across the batch; held bits from `latest`. */
  mergedActions: number;
}

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

function sanitize(d: MovementDatagram): MovementDatagram {
  return {
    ...d,
    facing: finite(d.facing),
    movementX: finite(d.movementX),
    movementY: finite(d.movementY),
    chargeMs: finite(d.chargeMs),
    timestamp: finite(d.timestamp),
  };
}

/**
 * Merge one tick's drained datagrams. Returns null when nothing survives
 * (empty batch, or everything was stale ≤ `lastAppliedSeq`).
 */
export function sanitizeAndMergeInputs(
  inputs: readonly MovementDatagram[],
  lastAppliedSeq: number,
  heldActionMask: number,
): MergedInput | null {
  let latest: MovementDatagram | null = null;
  let oneShots = 0;
  for (const raw of inputs) {
    if (!Number.isFinite(raw.seq) || raw.seq <= lastAppliedSeq) continue; // stale / replayed
    const d = sanitize(raw);
    oneShots |= d.actions;
    if (latest === null || d.seq > latest.seq) latest = d;
  }
  if (latest === null) return null;
  return {
    latest,
    mergedActions: (oneShots & ~heldActionMask) | (latest.actions & heldActionMask),
  };
}
