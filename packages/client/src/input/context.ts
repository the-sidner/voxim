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
 * is equipped, exited on ESC / hammer unequip / explicit cancel.
 *
 * Build mode carries the chosen blueprint id, the placement tool inferred
 * from the blueprint's `placeable.tool` field, and (for polyline tools)
 * the running anchor position. The build ghost renderer subscribes to
 * this signal + the cursor cell to draw the preview.
 *
 * Mode transitions are fired as Intents; this signal snapshots the
 * current state for translator + renderer reads.
 */
export interface WorldCell {
  cellX: number;
  cellY: number;
}

export type Mode =
  | { kind: "normal" }
  | {
      kind: "build";
      blueprintId: string;
      tool: "single" | "polyline";
      polyline?: { lastAnchor: WorldCell };
    };

export const modeState = signal<Mode>({ kind: "normal" });

/**
 * Cursor's world cell, mirrored every frame from the renderer's
 * cursor-projection so the build ghost reads it reactively. Null when
 * the cursor isn't over the playable terrain.
 */
export const cursorCellState = signal<WorldCell | null>(null);
