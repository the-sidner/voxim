/// <reference lib="dom" />
/**
 * Dreamborn UI primitives.
 *
 * Every panel in the HUD composes from these.  The visual recipe
 * (pressed-metal pane, rivet corners, focus glow, etc.) lives in one
 * place — both here and the matching classes in `theme.css`.
 *
 * Spec: data/design/README.md and data/design/ui_kits/game/.
 */
import type { ComponentChildren, JSX, Ref } from "preact";
import { usePanel } from "../use_panel.ts";

// ── PANE ──────────────────────────────────────────────────────────────────────
//
// Draggable, focusable window with a titlebar, body, optional foot, and four
// rivet corners. The rivets are drawn by ::before/::after on `.pane`,
// `.pane-titlebar`, and `.pane-foot`; this component just supplies the markup.

export interface PaneProps {
  /** Display title — Manrope eyebrow case (UPPERCASE done by CSS). */
  title: ComponentChildren;
  /** Small leading glyph (◆) — drops off on close-buttoned modals. */
  glyph?: string;
  /** Focused panes get an ember rim + glow. */
  focused?: boolean;
  /** Click anywhere on the pane to raise focus to it. */
  onFocus?: () => void;
  /** Renders an "×" in the titlebar; absent buttons mean undismissable. */
  onClose?: () => void;
  /** Bottom row — `<kbd>` hints, page counters, weight readouts. */
  foot?: ComponentChildren;
  /** Inline width/height overrides for unusual panes. */
  style?: JSX.CSSProperties;
  /** Initial pixel position when first opened. */
  defaultX?: number;
  defaultY?: number;
  children?: ComponentChildren;
  className?: string;
}

export function Pane({
  title,
  glyph = "◆",
  focused,
  onFocus,
  onClose,
  foot,
  style,
  defaultX,
  defaultY,
  children,
  className,
}: PaneProps) {
  const { panelProps, titleProps } = usePanel({ defaultX, defaultY });
  return (
    <div
      class={`pane interactive ${focused ? "is-focused" : ""} ${className ?? ""}`}
      {...panelProps}
      style={{ ...panelProps.style, ...style }}
      onMouseDown={onFocus}
    >
      <div class="pane-titlebar" {...titleProps}>
        <span>
          <span class="pane-title-glyph">{glyph}</span>
          {title}
        </span>
        {onClose && (
          <button
            type="button"
            class="pane-close interactive"
            aria-label="Close"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          >×</button>
        )}
      </div>
      <div class="pane-body">{children}</div>
      {foot && <div class="pane-foot">{foot}</div>}
    </div>
  );
}

// ── SECTION ───────────────────────────────────────────────────────────────────
//
// The "VITALS" / "ATTRIBUTES" eyebrow + hairline above a group of rows.

export function Section({ title, hint, children }: {
  title: string;
  hint?: ComponentChildren;
  children?: ComponentChildren;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
      <div class="section-strip">
        <div class="h-section">{title}</div>
        {hint != null && <div class="label">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

// ── KEY/VALUE ROW ─────────────────────────────────────────────────────────────
//
// Used in stats, character pane, debug section. Rune on the left, value
// monospace right-aligned. Pass a rune glyph or leave empty for label-only rows.

export function StatRow({ rune, label, value, dim }: {
  rune?: string;
  label: ComponentChildren;
  value: ComponentChildren;
  dim?: boolean;
}) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: rune ? "16px 1fr auto" : "1fr auto",
      alignItems: "baseline",
      gap: "var(--s-3)",
      fontSize: "var(--fs-body)",
      color: dim ? "var(--bone-faint)" : "var(--bone)",
    }}>
      {rune && (
        <span style={{ fontFamily: "var(--font-display)", color: "var(--bone-dim)" }}>
          {rune}
        </span>
      )}
      <span style={{ color: "var(--bone-dim)" }}>{label}</span>
      <span class="num">{value}</span>
    </div>
  );
}

// ── SLOT ──────────────────────────────────────────────────────────────────────
//
// Bare cell — content is whatever you nest. `tier` controls glow tint
// (warm/aether/cursed). Use the structural classes from theme.css.

export interface SlotProps extends JSX.HTMLAttributes<HTMLDivElement> {
  empty?: boolean;
  active?: boolean;
  tier?: "warm" | "rare" | "aether" | "cursed" | null;
  /** Drop-target highlight — outer ember rim, inner glow. */
  dragover?: boolean;
  /** Refuse variant — purple-rot rim, ⊘ glyph. */
  refuse?: boolean;
  /** Cell-element ref — Preact functional components don't forward `ref`,
      so callers pass it explicitly via this prop. */
  elRef?: Ref<HTMLDivElement>;
}

export function Slot({
  empty,
  active,
  tier,
  dragover,
  refuse,
  class: cls,
  elRef,
  children,
  ...rest
}: SlotProps) {
  const classes = [
    "slot",
    "interactive",
    empty && "slot--empty",
    active && "slot--active",
    tier ?? "",
    dragover && "dragover",
    refuse && "refuse",
    cls ?? "",
  ].filter(Boolean).join(" ");
  return <div ref={elRef} class={classes} {...rest}>{children}</div>;
}

// ── BAR ───────────────────────────────────────────────────────────────────────
//
// Generic horizontal track. Vitals use this with rune + readout; charge bar
// uses the raw `.bar-track`/`.bar-fill`.

export function Bar({ channel, rune, fill, color, readout, low, gain }: {
  channel?: "health" | "stamina" | "hunger" | "mana";
  rune?: string;
  /** 0..1 */
  fill: number;
  /** Optional override colour — channel default applies otherwise. */
  color?: string;
  readout?: ComponentChildren;
  low?: boolean;
  /** Healing direction — switches to fast (120ms) transition. */
  gain?: boolean;
}) {
  const clamped = Math.max(0, Math.min(1, fill));
  return (
    <div class={`bar ${channel ?? ""} ${low ? "low" : ""}`}>
      {rune && <span class="bar-rune">{rune}</span>}
      <div class="bar-track">
        <div
          class={`bar-fill ${gain ? "gain" : ""}`}
          style={{
            width: `${(clamped * 100).toFixed(1)}%`,
            background: color,
          }}
        />
      </div>
      {readout != null && <span class="bar-readout num">{readout}</span>}
    </div>
  );
}

// ── BUTTON ────────────────────────────────────────────────────────────────────
//
// Pressed-metal button with primary / ghost / danger / aether variants.
// Use for chrome actions; for icon-only use the bare `.iconbtn` class.

export type BtnKind = "default" | "primary" | "ghost" | "danger" | "aether";

export function Btn({
  kind = "default",
  active,
  class: cls,
  children,
  ...rest
}: { kind?: BtnKind; active?: boolean } & JSX.HTMLAttributes<HTMLButtonElement>) {
  const variant = kind === "default" ? "" : `btn--${kind}`;
  return (
    <button
      type="button"
      class={`btn interactive ${variant} ${active ? "is-active" : ""} ${cls ?? ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// ── KBD ───────────────────────────────────────────────────────────────────────
//
// Keycap chip — small monospace label inside a hairline box. Used in pane
// feet ("[I] burden  [C] character").

export function Kbd({ children }: { children: ComponentChildren }) {
  return <span class="kbd">{children}</span>;
}
