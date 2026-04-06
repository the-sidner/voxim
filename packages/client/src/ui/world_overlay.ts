/// <reference lib="dom" />
/**
 * WorldOverlay — imperative screen-space overlay for frame-driven elements.
 *
 * NOT reactive.  The render loop drives this directly (same pattern as the
 * old GameHud) because these elements update every frame at world-projected
 * screen coordinates — running them through signals would be wasteful.
 *
 *   Entity health bars — shown above NPCs/players when damaged
 *   Floating damage/heal numbers — rise and fade at entity screen position
 *
 * Lives in a fixed <div> layer beneath the Preact UI root so it doesn't
 * interfere with panel pointer events.
 */

// Inject the float animation once.
const STYLE_ID = "__voxim_world_overlay_style";
if (!document.getElementById(STYLE_ID)) {
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes floatUp {
      0%   { opacity: 1; transform: translate(-50%, 0); }
      100% { opacity: 0; transform: translate(-50%, -90px); }
    }
  `;
  document.head.appendChild(s);
}

interface EntityBar {
  wrap: HTMLDivElement;
  fill: HTMLDivElement;
}

export class WorldOverlay {
  private readonly container: HTMLDivElement;
  private readonly entityBars = new Map<string, EntityBar>();

  constructor() {
    this.container = document.createElement("div");
    Object.assign(this.container.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "100",         // below Preact UI panels (var(--z-panel) = 200)
      overflow: "hidden",
    });
    document.body.appendChild(this.container);
  }

  // ── Entity health bars ─────────────────────────────────────────────────────

  /**
   * Called at the start of each render frame — hides all bars.
   * Visible bars are re-shown by setEntityHealth() for each entity in view.
   */
  clearEntityBars(): void {
    for (const bar of this.entityBars.values()) {
      bar.wrap.style.display = "none";
    }
  }

  /** Create or update a floating health bar at screen position (sx, sy). */
  setEntityHealth(id: string, current: number, max: number, sx: number, sy: number): void {
    let bar = this.entityBars.get(id);
    if (!bar) {
      const wrap = document.createElement("div");
      Object.assign(wrap.style, {
        position: "absolute",
        width: "48px", height: "5px",
        background: "var(--col-bg)",
        border: "1px solid var(--col-border)",
        borderRadius: "var(--radius-sm)",
        overflow: "hidden",
      });
      const fill = document.createElement("div");
      Object.assign(fill.style, {
        height: "100%",
        background: "var(--col-health)",
        transition: "width 0.1s, background 0.2s",
      });
      wrap.appendChild(fill);
      this.container.appendChild(wrap);
      bar = { wrap, fill };
      this.entityBars.set(id, bar);
    }

    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
    if (ratio >= 1) { bar.wrap.style.display = "none"; return; }

    bar.fill.style.width = `${Math.round(ratio * 100)}%`;
    bar.fill.style.background = ratio < 0.3
      ? "var(--col-health-low)"
      : "var(--col-health)";
    bar.wrap.style.left = `${sx - 24}px`;
    bar.wrap.style.top  = `${sy - 60}px`;
    bar.wrap.style.display = "block";
  }

  removeEntityBar(id: string): void {
    const bar = this.entityBars.get(id);
    if (bar) { bar.wrap.remove(); this.entityBars.delete(id); }
  }

  // ── Floating numbers ───────────────────────────────────────────────────────

  /**
   * Show a floating damage number.
   * blocked = true → show in blue as "(n)" instead of "-n".
   */
  showDamage(sx: number, sy: number, amount: number, blocked: boolean): void {
    const el = document.createElement("div");
    el.textContent = blocked ? `(${amount})` : `-${amount}`;
    Object.assign(el.style, {
      position: "absolute",
      left: `${sx}px`,
      top:  `${sy - 40}px`,
      transform: "translate(-50%, 0)",
      color:      blocked ? "var(--col-info)" : "var(--col-danger)",
      fontSize:   blocked ? "var(--text-sm)"  : "var(--text-base)",
      fontWeight: "bold",
      textShadow: "0 1px 4px #000",
      pointerEvents: "none",
      animation: "floatUp 1.2s ease-out forwards",
    });
    this.container.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  }

  // TODO: showHeal(sx, sy, amount) — green floating number
  // TODO: showCombatText(sx, sy, text, kind) — generic labelled events

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  dispose(): void {
    this.container.remove();
  }
}
