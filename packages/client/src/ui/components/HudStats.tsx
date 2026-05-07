/// <reference lib="dom" />
/**
 * HUD diagnostics tucked next to the minimap.
 *
 *   ▷ FPS         — sampled client-side from rAF deltas (game.ts publishes
 *                   every ~500 ms so the value reads cleanly).
 *   ▷ Online      — authoritative tile session count from the latest
 *                   BinaryStateMessage; this is "people on this tile",
 *                   not "people on the whole world" (cross-tile would need
 *                   a gateway aggregate, future work).
 */
import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";

const stats = computed(() => uiState.value.hudStats);

const ROW: Record<string, string> = {
  display:        "flex",
  justifyContent: "space-between",
  alignItems:     "baseline",
  gap:            "12px",
  fontSize:       "12px",
  lineHeight:     "1.3",
};
const LABEL: Record<string, string> = {
  color:         "var(--col-text-muted, #9aa)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
const VALUE: Record<string, string> = {
  color:      "var(--col-text, #ffeebb)",
  fontFamily: "ui-monospace, monospace",
  fontWeight: "600",
};

export function HudStats() {
  const s = stats.value;
  return (
    <div style={{
      position: "fixed",
      top:      "12px",
      right:    "220px",   // 12 (minimap right) + 200 (minimap width) + 8 gap
      minWidth: "108px",
      padding:  "6px 10px",
      background:   "rgba(0, 0, 0, 0.55)",
      border:       "1px solid rgba(220, 220, 220, 0.25)",
      borderRadius: "4px",
      zIndex:       "var(--z-hud)",
      pointerEvents: "none",
    }}>
      <div style={ROW}>
        <span style={LABEL}>fps</span>
        <span style={VALUE}>{s.fps || "—"}</span>
      </div>
      <div style={ROW}>
        <span style={LABEL}>online</span>
        <span style={VALUE}>{s.onlineCount}</span>
      </div>
    </div>
  );
}
