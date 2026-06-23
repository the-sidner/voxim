/**
 * Typed intent union — every "thing the player wants to happen" that flows
 * through the IntentRouter. Replaces the ad-hoc UIAction + onLmbClick +
 * onBuildPlace + onBuildOpenMenu callback surface.
 *
 * Naming convention: kebab-case kind discriminant, prefix groups intents
 * by domain ("world-…", "ui-…", "build-…", "mode-…").
 */

import type { UIAction } from "../ui/ui_actions.ts";

/** Where the cursor is hovering when an intent is emitted. */
export type HoverTarget =
  | { kind: "entity";  entityId: string }
  | { kind: "terrain"; worldX: number; worldY: number; cellX: number; cellY: number }
  | { kind: "none" };

export type Intent =
  // ── Combat / world actions ────────────────────────────────────────────
  | {
      kind: "world-main-action";
      /** Press-and-hold duration in ms (0 for taps). Server picks the swing variant. */
      chargeMs: number;
      hover: HoverTarget;
    }
  | { kind: "block-start" }
  | { kind: "block-end" }

  // ── Hover-driven interaction ──────────────────────────────────────────
  | {
      kind: "interact";
      hover: HoverTarget;
    }

  // ── Build mode ────────────────────────────────────────────────────────
  | { kind: "open-build-radial"; canvasX: number; canvasY: number }
  | { kind: "select-blueprint";  blueprintId: string }
  /**
   * LMB while in build mode. Single-tool blueprints place a voxel at the cursor
   * column's top; line-tool blueprints set the anchor on the first click and
   * commit the spacing-decimated line on the second.
   */
  | { kind: "build-action";      canvasX: number; canvasY: number }
  /**
   * RMB tap in build mode. The line tool clears a staged anchor; if nothing is
   * staged, exits build mode (same effect as build-cancel).
   */
  | { kind: "build-undo" }
  /** ESC / hammer unequip: clear chain and exit build mode. */
  | { kind: "build-cancel" }

  // ── UI passthrough — every existing UIAction shape becomes an intent. ─
  // The router treats these the same as world intents; UI handlers register
  // for `ui-*` claims while world handlers register for everything else.
  | { kind: "ui"; action: UIAction };
