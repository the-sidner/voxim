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
 * The cursor's resolved voxel placement target (T-284). The flat-plane ray gives
 * the column (cellX,cellY); the renderer then samples the terrain top (`baseZ`,
 * snapped to the 0.25 lattice) and the column's current stack height (`layer`).
 * The voxel CENTER z is DERIVED per brush, never stored here:
 *   placeZ(hit, voxelSize) = hit.baseZ + hit.layer * voxelSize + voxelSize/2
 * `layer` is the load-bearing field chunk 2 will validate server-side; the hit
 * stays brush-agnostic (voxelSize lives on the brush, not the hit).
 */
export interface VoxelHit {
  /** Integer column under the cursor (floor of the ground-plane hit). */
  cellX: number;
  cellY: number;
  /** Terrain top for this column, snapHeight-quantized — what layer 0 rests on. */
  baseZ: number;
  /** Voxels already stacked in this column (0 = bare terrain). */
  layer: number;
}

/**
 * The build brush — the "single voxel or line, with size + spacing" descriptor.
 * `tool` comes from the blueprint's `placeable.tool`; voxelSize/spacing default
 * from game_config and are adjusted live via the build HUD.
 */
export interface BuildBrush {
  tool: "single" | "line";
  /** Voxel edge size in world units (a 0.25 multiple keeps voxels on-lattice). */
  voxelSize: number;
  /** Cells skipped between line stamps (0 = solid). */
  spacing: number;
}

/**
 * Persistent mode the player is in. "normal" is the default — combat,
 * harvesting, etc. "build" is entered via the radial menu when a hammer
 * is equipped, exited on ESC / hammer unequip / explicit cancel.
 *
 * Build mode carries the chosen blueprint id, the brush, and (for the line
 * tool) the staged anchor hit. The build ghost renderer subscribes to this
 * signal + the cursor voxel to draw the preview.
 *
 * Mode transitions are fired as Intents; this signal snapshots the
 * current state for translator + renderer reads.
 */
export type Mode =
  | { kind: "normal" }
  | {
      kind: "build";
      blueprintId: string;
      brush: BuildBrush;
      line?: { anchor: VoxelHit };
    };

export const modeState = signal<Mode>({ kind: "normal" });

/**
 * Cursor's resolved voxel target, mirrored every frame from the renderer's
 * cursor pick so the build ghost reads it reactively. Null when the cursor
 * isn't over the playable terrain.
 */
export const cursorVoxelState = signal<VoxelHit | null>(null);
