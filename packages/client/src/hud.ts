/// <reference lib="dom" />
/**
 * HUD — DOM overlay for in-game feedback.
 *
 * Components:
 *   - Crosshair         — fixed center dot
 *   - Status bars       — HP / Stamina / Hunger stacked at bottom-center
 *   - Floating numbers  — damage dealt / blocked, fade-up at world position
 *   - Alert banner      — events (death, hunger, day phase…) auto-dismiss top-center
 */

// Inject float animation once into the document
const STYLE_ID = "__voxim_hud_style";
if (!document.getElementById(STYLE_ID)) {
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes hudFloat {
      0%   { opacity: 1; transform: translate(-50%, 0); }
      100% { opacity: 0; transform: translate(-50%, -130px); }
    }
  `;
  document.head.appendChild(s);
}

function makeBar(label: string, fillColor: string): {
  wrap: HTMLDivElement;
  fill: HTMLDivElement;
  text: HTMLSpanElement;
} {
  const wrap = document.createElement("div");
  Object.assign(wrap.style, {
    display: "flex", alignItems: "center", gap: "6px", width: "220px",
  });

  const lbl = document.createElement("span");
  lbl.textContent = label;
  Object.assign(lbl.style, {
    color: "#777", fontSize: "10px", width: "16px", textAlign: "right",
    letterSpacing: "0.06em", flexShrink: "0",
  });
  wrap.appendChild(lbl);

  const track = document.createElement("div");
  Object.assign(track.style, {
    flex: "1", height: "8px",
    background: "#111", border: "1px solid #2a2a2a", borderRadius: "2px",
    overflow: "hidden",
  });

  const fill = document.createElement("div");
  Object.assign(fill.style, {
    height: "100%", width: "100%",
    background: fillColor,
    transition: "width 0.15s, background 0.3s",
  });
  track.appendChild(fill);
  wrap.appendChild(track);

  const text = document.createElement("span");
  Object.assign(text.style, {
    color: "#666", fontSize: "9px", width: "52px", textAlign: "left",
    flexShrink: "0",
  });
  wrap.appendChild(text);

  return { wrap, fill, text };
}

interface EntityBar { wrap: HTMLDivElement; fill: HTMLDivElement }

export class GameHud {
  private readonly container: HTMLDivElement;
  private readonly healthFill: HTMLDivElement;
  private readonly healthText: HTMLSpanElement;
  private readonly staminaFill: HTMLDivElement;
  private readonly staminaText: HTMLSpanElement;
  private readonly hungerFill: HTMLDivElement;
  private readonly hungerText: HTMLSpanElement;
  private readonly floatContainer: HTMLDivElement;
  private readonly alertEl: HTMLDivElement;
  private readonly entityBars = new Map<string, EntityBar>();
  private alertTimer = 0;
  private readonly arcCanvas: HTMLCanvasElement;
  private readonly arcCtx: CanvasRenderingContext2D;
  private readonly activeArcs: Array<{ sx: number; sy: number; angle: number; arcHalf: number; radius: number; alpha: number }> = [];
  private arcLoopId = 0;

  constructor() {
    this.container = document.createElement("div");
    Object.assign(this.container.style, {
      position: "fixed", inset: "0", pointerEvents: "none",
      fontFamily: "monospace", userSelect: "none",
    });

    // ── Crosshair ─────────────────────────────────────────────────────────────
    const ch = document.createElement("div");
    Object.assign(ch.style, {
      position: "absolute", left: "50%", top: "50%",
      width: "6px", height: "6px",
      marginLeft: "-3px", marginTop: "-3px",
      borderRadius: "50%",
      background: "rgba(255,255,255,0.85)",
      boxShadow: "0 0 0 1.5px rgba(0,0,0,0.5)",
    });
    this.container.appendChild(ch);

    // ── Status bars (HP / ST / HG) ────────────────────────────────────────────
    const statusWrap = document.createElement("div");
    Object.assign(statusWrap.style, {
      position: "absolute", bottom: "24px", left: "50%",
      transform: "translateX(-50%)",
      display: "flex", flexDirection: "column", gap: "5px",
    });

    const hp = makeBar("HP", "#3c9");
    this.healthFill = hp.fill;
    this.healthText = hp.text;
    statusWrap.appendChild(hp.wrap);

    const st = makeBar("ST", "#38f");
    this.staminaFill = st.fill;
    this.staminaText = st.text;
    statusWrap.appendChild(st.wrap);

    const hg = makeBar("HG", "#b72");
    this.hungerFill = hg.fill;
    this.hungerText = hg.text;
    statusWrap.appendChild(hg.wrap);

    this.container.appendChild(statusWrap);

    // ── Floating damage numbers ───────────────────────────────────────────────
    this.floatContainer = document.createElement("div");
    Object.assign(this.floatContainer.style, { position: "absolute", inset: "0" });
    this.container.appendChild(this.floatContainer);

    // ── Alert banner ──────────────────────────────────────────────────────────
    this.alertEl = document.createElement("div");
    Object.assign(this.alertEl.style, {
      position: "absolute", top: "64px", left: "50%",
      transform: "translateX(-50%)",
      padding: "7px 20px", borderRadius: "4px",
      fontSize: "13px", fontWeight: "bold",
      color: "#fff", opacity: "0",
      transition: "opacity 0.25s",
      whiteSpace: "nowrap",
      background: "rgba(0,0,0,0.65)", border: "1px solid #444",
      letterSpacing: "0.05em",
    });
    this.container.appendChild(this.alertEl);

    // ── Attack arc canvas ─────────────────────────────────────────────────────
    this.arcCanvas = document.createElement("canvas");
    Object.assign(this.arcCanvas.style, {
      position: "absolute", inset: "0", pointerEvents: "none",
    });
    this.arcCtx = this.arcCanvas.getContext("2d")!;
    this.container.appendChild(this.arcCanvas);
    const resizeArc = () => {
      this.arcCanvas.width  = globalThis.innerWidth;
      this.arcCanvas.height = globalThis.innerHeight;
    };
    resizeArc();
    globalThis.addEventListener("resize", resizeArc);

    document.body.appendChild(this.container);
  }

  // ── public API ──────────────────────────────────────────────────────────────

  updateHealth(current: number, max: number): void {
    const ratio = max > 0 ? Math.max(0, current / max) : 0;
    this.healthFill.style.width = `${Math.round(ratio * 100)}%`;
    const r = Math.round(ratio < 0.5 ? 255 : (1 - ratio) * 2 * 255);
    const g = Math.round(ratio > 0.5 ? 180 : ratio * 2 * 180);
    this.healthFill.style.background = `rgb(${r},${g},40)`;
    this.healthText.textContent = `${Math.ceil(current)}/${Math.ceil(max)}`;
  }

  updateStamina(current: number, max: number, exhausted: boolean): void {
    const ratio = max > 0 ? Math.max(0, current / max) : 0;
    this.staminaFill.style.width = `${Math.round(ratio * 100)}%`;
    this.staminaFill.style.background = exhausted ? "#844" : "#38f";
    this.staminaText.textContent = exhausted ? "EXHAUSTED" : `${Math.ceil(current)}/${Math.ceil(max)}`;
  }

  /** hunger value: 0 = full, 100 = starving */
  updateHunger(value: number): void {
    const ratio = Math.max(0, Math.min(1, value / 100));
    this.hungerFill.style.width = `${Math.round(ratio * 100)}%`;
    this.hungerFill.style.background = ratio > 0.7 ? "#d44" : ratio > 0.4 ? "#c72" : "#b72";
    this.hungerText.textContent = ratio > 0.7 ? "starving" : ratio > 0.4 ? "hungry" : "fed";
  }

  /**
   * Spawn a floating damage number at canvas pixel position.
   * blocked → blue; otherwise red.
   */
  showDamage(screenX: number, screenY: number, amount: number, blocked: boolean): void {
    const el = document.createElement("div");
    el.textContent = blocked ? `(${amount})` : `-${amount}`;
    Object.assign(el.style, {
      position: "absolute",
      left: `${screenX}px`,
      top: `${screenY - 40}px`,
      transform: "translate(-50%, 0)",
      color: blocked ? "#88aaff" : "#ff5555",
      fontSize: blocked ? "12px" : "15px",
      fontWeight: "bold",
      textShadow: "0 1px 4px #000",
      pointerEvents: "none",
      animation: "hudFloat 1.2s ease-out forwards",
    });
    this.floatContainer.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  }

  /** Show a timed alert banner (auto-dismissed after ~2.8 s). */
  showAlert(text: string, color = "#ffffff"): void {
    this.alertEl.textContent = text;
    this.alertEl.style.color = color;
    this.alertEl.style.opacity = "1";
    clearTimeout(this.alertTimer);
    this.alertTimer = setTimeout(() => {
      this.alertEl.style.opacity = "0";
    }, 2800) as unknown as number;
  }

  /** Called at the start of each frame — hides all entity bars before re-showing visible ones. */
  clearEntityBars(): void {
    for (const bar of this.entityBars.values()) {
      bar.wrap.style.display = "none";
    }
  }

  /** Create or update a floating health bar above a world entity (screen coords). */
  setEntityHealth(id: string, current: number, max: number, sx: number, sy: number): void {
    let bar = this.entityBars.get(id);
    if (!bar) {
      const wrap = document.createElement("div");
      Object.assign(wrap.style, {
        position: "absolute",
        width: "48px", height: "5px",
        background: "#111", border: "1px solid #333", borderRadius: "2px",
        overflow: "hidden",
        pointerEvents: "none",
      });
      const fill = document.createElement("div");
      Object.assign(fill.style, {
        height: "100%", width: "100%",
        background: "#3c9",
        transition: "width 0.1s, background 0.2s",
      });
      wrap.appendChild(fill);
      this.floatContainer.appendChild(wrap);
      bar = { wrap, fill };
      this.entityBars.set(id, bar);
    }

    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
    const r = Math.round(ratio < 0.5 ? 255 : (1 - ratio) * 2 * 255);
    const g = Math.round(ratio > 0.5 ? 180 : ratio * 2 * 180);

    bar.fill.style.width = `${Math.round(ratio * 100)}%`;
    bar.fill.style.background = `rgb(${r},${g},40)`;
    bar.wrap.style.left = `${sx - 24}px`;
    bar.wrap.style.top = `${sy - 60}px`;
    bar.wrap.style.display = ratio >= 1 ? "none" : "block";
  }

  /**
   * Flash the player's attack arc (screen-space wedge) for the duration of the swing.
   * facingAngle is the atan2 screen-space angle from InputController.
   */
  /**
   * Flash an attack arc (screen-space wedge) centred at (sx, sy) pointing toward (tx, ty).
   * arcHalf and radius are in screen-space units, derived from the weapon action geometry.
   * Multiple simultaneous arcs are supported — one per active attacker.
   */
  showSwingArc(sx: number, sy: number, tx: number, ty: number, arcHalf: number, radius: number): void {
    const angle = Math.atan2(ty - sy, tx - sx);
    this.activeArcs.push({ sx, sy, angle, arcHalf, radius, alpha: 0.5 });
    if (this.arcLoopId === 0) this.arcLoop();
  }

  private arcLoop(): void {
    const ctx = this.arcCtx;
    ctx.clearRect(0, 0, this.arcCanvas.width, this.arcCanvas.height);

    for (let i = this.activeArcs.length - 1; i >= 0; i--) {
      const arc = this.activeArcs[i];
      ctx.globalAlpha = arc.alpha;
      ctx.beginPath();
      ctx.moveTo(arc.sx, arc.sy);
      ctx.arc(arc.sx, arc.sy, arc.radius, arc.angle - arc.arcHalf, arc.angle + arc.arcHalf);
      ctx.closePath();
      ctx.fillStyle = "#ff5500";
      ctx.fill();
      ctx.strokeStyle = "#ffaa00";
      ctx.lineWidth = 2;
      ctx.stroke();
      arc.alpha -= 0.025;
      if (arc.alpha <= 0) this.activeArcs.splice(i, 1);
    }

    ctx.globalAlpha = 1;
    if (this.activeArcs.length > 0) {
      this.arcLoopId = requestAnimationFrame(() => this.arcLoop());
    } else {
      this.arcLoopId = 0;
      ctx.clearRect(0, 0, this.arcCanvas.width, this.arcCanvas.height);
    }
  }

  /** Remove the health bar for an entity that has been destroyed. */
  removeEntityBar(id: string): void {
    const bar = this.entityBars.get(id);
    if (bar) {
      bar.wrap.remove();
      this.entityBars.delete(id);
    }
  }

  dispose(): void {
    clearTimeout(this.alertTimer);
    cancelAnimationFrame(this.arcLoopId);
    this.container.remove();
  }
}
