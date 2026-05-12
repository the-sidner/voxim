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

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--s-3)" }}>
      <span style={{ color: "var(--bone-faint)", textTransform: "uppercase", letterSpacing: "var(--ls-eyebrow)" }}>
        {label}
      </span>
      <span class="num" style={{ color: "var(--bone)" }}>{value}</span>
    </div>
  );
}

function Sep() {
  return <div style={{ height: 1, background: "var(--line)", margin: "2px 0" }} />;
}

export function HudStats() {
  const s = stats.value;
  return (
    <div class="hud-chrome" style={{
      position: "fixed",
      top:      "var(--s-4)",
      right:    "192px",   /* minimap (172) + gap */
      minWidth: "120px",
      padding:  "var(--s-2) var(--s-4)",
      zIndex:   "var(--z-hud)",
      pointerEvents: "none",
      display:  "flex",
      flexDirection: "column",
      gap:      "1px",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--fs-eyebrow)",
      letterSpacing: "var(--ls-mono)",
    }}>
      <Row label="fps"      value={s.fps || "—"} />
      <Row label="online"   value={s.onlineCount} />
      <Sep />
      <Row label="frame"    value={`${s.frameMs.toFixed(1)} ms`} />
      <Row label="sk+ik"    value={`${s.skMs.toFixed(1)} ms`} />
      <Row label="trail"    value={`${s.trailMs.toFixed(1)} ms`} />
      <Row label="gl"       value={`${s.glMs.toFixed(1)} ms`} />
      <Row label="post"     value={`${s.postMs.toFixed(1)} ms`} />
      <Sep />
      <Row label="draws"    value={s.drawCalls} />
      <Row label="tris"     value={`${(s.tris / 1000).toFixed(1)}k`} />
      <Row label="entities" value={s.entities} />
      <Row label="handles"  value={s.handles} />
      <Sep />
      <Row label="ping"     value={s.pingMs > 0 ? `${s.pingMs} ms` : "—"} />
      <Row label="lag"      value={s.inputLag} />
      <Row label="tick"     value={`${s.tickHz.toFixed(1)} Hz`} />
      <Row label="down"     value={`${s.kbpsIn.toFixed(0)} kb/s`} />
    </div>
  );
}
