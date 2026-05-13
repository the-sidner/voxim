/**
 * "You are in: X" HUD caption (T-211).
 *
 * Tracks `currentZoneName` and renders a fixed-position label in the
 * top-centre of the screen. Empty name → hidden (sub-threshold zones
 * shouldn't litter the HUD). Wilderness vs path traversal gets a
 * subtle icon hint.
 */
import { currentZoneName, currentZoneRole, currentZoneTraversal } from "../zone_ref.ts";

export function ZoneCaption() {
  const name      = currentZoneName.value;
  const role      = currentZoneRole.value;
  const traversal = currentZoneTraversal.value;
  if (!name) return null;
  const icon = traversal === "wilderness" ? "⛰" : "·";
  return (
    <div class="hud-chrome" style={{
      position: "fixed",
      top:      "var(--s-6)",
      left:     "50%",
      transform: "translateX(-50%)",
      padding:  "var(--s-2) var(--s-4)",
      zIndex:   "var(--z-hud)",
      pointerEvents: "none",
      fontFamily: "var(--font-display, var(--font-mono))",
      fontSize: "var(--fs-body)",
      letterSpacing: "var(--ls-mono)",
      color: "var(--text)",
      background: "color-mix(in oklab, var(--bg) 70%, transparent)",
      borderRadius: "var(--radius-2)",
      whiteSpace: "nowrap",
    }}>
      <span style={{ color: "var(--text-dim)", marginRight: 6 }}>{icon}</span>
      <span style={{ color: "var(--text-dim)" }}>You are in </span>
      <strong>{name}</strong>
      <span style={{ color: "var(--text-dim)", marginLeft: 6, fontSize: "var(--fs-eyebrow)" }}>· {role}</span>
    </div>
  );
}
