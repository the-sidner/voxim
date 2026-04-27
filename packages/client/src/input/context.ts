/**
 * Live state slices the IntentTranslator reads to decide what each raw event
 * means right now. Everything is a Preact signal so subscribers (charge bar,
 * build ghost renderer, T-131) re-render reactively without polling.
 */
import { signal } from "@preact/signals";
import type { HoverTarget } from "./intents.ts";

// ---- HoverState ----------------------------------------------------------

/** What the cursor is over right now. Updated each frame by the
 *  InteractionSystem (entity raycast) plus terrain-cell projection. */
export const hoverState = signal<HoverTarget>({ kind: "none" });

// ---- HoldState -----------------------------------------------------------

/**
 * Tracks press-and-hold gestures with timestamps, so release events can
 * compute durations. Today only LMB charging is wired; RMB-long-press
 * (radial menu) lives in InputController-style timer.
 */
export interface LmbHold {
  /** performance.now() at LMB-down. */
  downAtMs: number;
  /** Canvas position at down — kept for renderer hooks (charge bar location). */
  canvasX: number;
  canvasY: number;
}

export const holdState = signal<{ lmb: LmbHold | null }>({ lmb: null });

// ---- Mode ----------------------------------------------------------------

/**
 * Persistent mode the player is in. "normal" is the default — combat,
 * harvesting, etc. "build" is entered via the radial menu when a hammer
 * is equipped (T-131 makes this stateful with polyline tracking; T-130
 * carries the legacy single-shot place flow as `selectedBlueprint`).
 *
 * Mode transitions are fired as Intents; this signal just snapshots the
 * current state for translator + renderer reads.
 */
export type Mode =
  | { kind: "normal" }
  | { kind: "build"; blueprintId: string };

export const modeState = signal<Mode>({ kind: "normal" });
