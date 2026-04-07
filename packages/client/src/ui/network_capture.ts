/**
 * NetworkCapture — ring-buffer recorder for all protocol traffic.
 *
 * game.ts calls the record*() helpers whenever a message is sent or received.
 * The panel reads from `captureSignal` and `captureSeq` (a monotonic counter
 * that bumps on every push — cheaper than diffing the whole array).
 *
 * Ring buffer is capped at MAX_ENTRIES.  When full, oldest entries drop off.
 * Recording can be paused so the list freezes for inspection.
 */
import { signal } from "@preact/signals";
import type { MovementDatagram, BinaryStateMessage, WorldSnapshot } from "@voxim/protocol";
import {
  ACTION_USE_SKILL, ACTION_BLOCK, ACTION_JUMP, ACTION_INTERACT,
  ACTION_DODGE, ACTION_SKILL_1, ACTION_SKILL_2, ACTION_SKILL_3, ACTION_SKILL_4,
} from "@voxim/protocol";

// ── Types ──────────────────────────────────────────────────────────────────────

export type CaptureChannel = "input" | "state" | "event" | "snapshot";
export type CaptureDir     = "in" | "out";

export interface CapturedMessage {
  /** Monotonic id — used as React key. */
  id:       number;
  channel:  CaptureChannel;
  dir:      CaptureDir;
  /** performance.now() at capture time. */
  t:        number;
  bytes:    number;
  /** Short one-line description shown in the list. */
  summary:  string;
  /** Decoded fields shown in the detail pane. */
  fields:   Record<string, unknown>;
}

// ── Store ──────────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 500;
let _seq = 0;

/** The captured message list.  Components should read this. */
export const captureSignal = signal<CapturedMessage[]>([]);

/**
 * Bumps on every push regardless of paused state.
 * Lets components detect new messages without re-reading the full array.
 */
export const captureSeq    = signal(0);

/** When true, new messages are recorded but captureSignal is not updated. */
export const capturePaused = signal(false);

/** When true, no messages are recorded at all (no-op on all record calls). */
export const captureEnabled = signal(true);

// ── Private push ──────────────────────────────────────────────────────────────

function push(msg: Omit<CapturedMessage, "id">): void {
  if (!captureEnabled.value) return;
  const entry: CapturedMessage = { id: ++_seq, ...msg };
  captureSeq.value = _seq;
  if (capturePaused.value) return;
  const prev = captureSignal.value;
  const next = prev.length >= MAX_ENTRIES
    ? [...prev.slice(prev.length - MAX_ENTRIES + 1), entry]
    : [...prev, entry];
  captureSignal.value = next;
}

export function clearCapture(): void {
  captureSignal.value = [];
}

// ── Action bit decoder ─────────────────────────────────────────────────────────

function decodeActions(bits: number): Record<string, boolean> {
  return {
    USE_SKILL: !!(bits & ACTION_USE_SKILL),
    BLOCK:     !!(bits & ACTION_BLOCK),
    JUMP:      !!(bits & ACTION_JUMP),
    INTERACT:  !!(bits & ACTION_INTERACT),
    DODGE:     !!(bits & ACTION_DODGE),
    SKILL_1:   !!(bits & ACTION_SKILL_1),
    SKILL_2:   !!(bits & ACTION_SKILL_2),
    SKILL_3:   !!(bits & ACTION_SKILL_3),
    SKILL_4:   !!(bits & ACTION_SKILL_4),
  };
}

function activeActions(bits: number): string[] {
  return Object.entries(decodeActions(bits))
    .filter(([, v]) => v)
    .map(([k]) => k);
}

// ── Public record helpers ──────────────────────────────────────────────────────

/**
 * Record an outgoing MovementDatagram.
 * Call from game.ts immediately after sendMovement().
 */
export function recordInput(dg: MovementDatagram): void {
  const active = activeActions(dg.actions);
  push({
    channel: "input",
    dir:     "out",
    t:       performance.now(),
    bytes:   33,  // fixed MovementDatagram size
    summary: active.length
      ? `seq=${dg.seq}  [${active.join(" ")}]`
      : `seq=${dg.seq}  mov=(${dg.movementX.toFixed(2)},${dg.movementY.toFixed(2)})`,
    fields: {
      seq:         dg.seq,
      tick:        dg.tick,
      timestamp:   dg.timestamp,
      facing:      +dg.facing.toFixed(4),
      movementX:   +dg.movementX.toFixed(4),
      movementY:   +dg.movementY.toFixed(4),
      actions:     decodeActions(dg.actions),
      actionsBits: `0x${dg.actions.toString(16).padStart(8, "0")}`,
    },
  });
}

/**
 * Record an incoming StateMessage.
 * Call from game.ts onStateMessage handler.
 */
export function recordState(msg: BinaryStateMessage): void {
  // Estimate size: each component delta is variable; use a rough heuristic.
  const approxBytes = 8 + msg.deltas.length * 24 + msg.destroys.length * 8 + msg.events.length * 32;

  push({
    channel: "state",
    dir:     "in",
    t:       performance.now(),
    bytes:   approxBytes,
    summary: `tick=${msg.serverTick}  Δ=${msg.deltas.length} spawn=${msg.spawns.length} destroy=${msg.destroys.length} ev=${msg.events.length} ack=${msg.ackInputSeq}`,
    fields: {
      serverTick:    msg.serverTick,
      ackInputSeq:   msg.ackInputSeq,
      spawns:        msg.spawns.length,
      deltas:        msg.deltas.length,
      destroys:      msg.destroys,
      events:        msg.events.map((e) => ({ ...e })),
      // Expand delta summary: entity id + which component types changed
      deltaDetail:   msg.deltas.map((d) => ({
        entityId:   d.entityId,
        componentType: d.componentType,
      })),
    },
  });

  // Also record each game event as its own "event" channel entry
  for (const ev of msg.events) {
    push({
      channel: "event",
      dir:     "in",
      t:       performance.now(),
      bytes:   0,
      summary: ev.type,
      fields:  { ...ev },
    });
  }
}

/**
 * Record an incoming world snapshot.
 * Call from game.ts onSnapshot handler.
 */
export function recordSnapshot(snap: WorldSnapshot): void {
  push({
    channel: "snapshot",
    dir:     "in",
    t:       performance.now(),
    bytes:   6 + snap.entities.length * 44,  // header + fixed entity size
    summary: `tick=${snap.serverTick}  entities=${snap.entities.length}`,
    fields: {
      serverTick:  snap.serverTick,
      entityCount: snap.entities.length,
    },
  });
}
