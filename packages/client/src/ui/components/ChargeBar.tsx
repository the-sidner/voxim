/// <reference lib="dom" />
/**
 * Small charge bar for the LMB-held attack. Reads HoldState.lmb reactively;
 * disappears when nothing is held. Position-locked to the held canvas point
 * (offset slightly so it doesn't sit under the cursor).
 *
 * Width fills against `MAX_CHARGE_MS`; once full, the heavy attack tier is
 * unlocked. T-130 doesn't yet read the equipped weapon's charge thresholds
 * here — every weapon's bar uses the same scale so the player learns timing
 * from feedback rather than a tooltip. Per-weapon thresholds can come later.
 */
import { computed, useSignalEffect } from "@preact/signals";
import { useState } from "preact/hooks";
import { holdState } from "../../input/context.ts";

const MAX_CHARGE_MS = 500;
const HEAVY_THRESHOLD_MS = 200;

const lmb = computed(() => holdState.value.lmb);

export function ChargeBar() {
  // Use a tick signal to re-render every animation frame while charging —
  // HoldState only changes on press/release, but the bar fill is time-driven.
  const [now, setNow] = useState(() => performance.now());
  useSignalEffect(() => {
    if (!lmb.value) return;
    let raf = 0;
    const loop = () => { setNow(performance.now()); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  const held = lmb.value;
  if (!held) return null;

  const elapsed  = now - held.downAtMs;
  const fraction = Math.min(1, elapsed / MAX_CHARGE_MS);
  const heavy    = elapsed >= HEAVY_THRESHOLD_MS;

  return (
    <div style={{
      position: "fixed",
      left:   `${held.canvasX - 24}px`,
      top:    `${held.canvasY + 18}px`,
      width:  "48px",
      height: "6px",
      background: "rgba(20, 16, 10, 0.6)",
      border: "1px solid rgba(200, 180, 120, 0.4)",
      borderRadius: "3px",
      pointerEvents: "none",
      zIndex: "var(--z-tooltip)",
      overflow: "hidden",
    }}>
      <div style={{
        width:      `${fraction * 100}%`,
        height:     "100%",
        background: heavy ? "var(--col-accent)" : "var(--col-text-dim)",
        transition: "background 80ms ease-out",
      }} />
    </div>
  );
}
