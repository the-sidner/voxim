/**
 * HeirRitual — respawn/heir-flow guidance banner (T-072).
 *
 * Non-modal HUD chrome, visible only while `uiState.heirRitual` is non-null.
 * game.ts arms the underlying flag the moment it sees the local player's own
 * `Heritage.generation` climb during THIS session — a genuine death → heir
 * respawn (T-079/T-270), not just joining as an already-established heir —
 * then keeps rescanning known entities for the player's own dynasty's
 * library/treasury chests (`_recomputeRitualGuide` in game.ts).
 *
 * Each step only exists while its matching chest genuinely still holds
 * something: this reads real Container state, it does not script a fixed
 * sequence. No chest built yet, or already emptied out → no step, and once
 * both are gone the whole banner disappears on its own. There is
 * deliberately no "do it for me" button — reading a tome and equipping gear
 * both go through the ordinary inventory/container UI (InventoryPanel's
 * "Read" action, drag-to-equip); this banner only points the way.
 */
import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";
import type { UIAction } from "../ui_actions.ts";

const heirRitual = computed(() => uiState.value.heirRitual);

export function HeirRitual({ onAction }: { onAction: (a: UIAction) => void }) {
  const ritual = heirRitual.value;
  if (!ritual || ritual.steps.length === 0) return null;

  return (
    <div
      class="hud-chrome interactive"
      style={{
        position: "fixed",
        top: "244px",
        right: "var(--s-4)",
        width: "196px",
        zIndex: "var(--z-hud)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-2)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{
          textTransform: "uppercase",
          letterSpacing: "var(--ls-eyebrow)",
          fontSize: "var(--fs-eyebrow)",
          color: "var(--bone-faint)",
        }}>
          Rite of Inheritance
        </span>
        <button
          type="button"
          class="pane-close interactive"
          aria-label="Dismiss"
          onClick={() => onAction({ type: "dismiss_ritual" })}
        >×</button>
      </div>
      {ritual.steps.map((s) => (
        <div key={s.containerId} style={{ fontFamily: "var(--font-body)", fontSize: "var(--fs-body)", color: "var(--bone)" }}>
          {s.kind === "tome"
            ? <>The family library holds <strong class="num">{s.pending}</strong> tome{s.pending === 1 ? "" : "s"} to read.</>
            : <>The family treasury holds <strong class="num">{s.pending}</strong> piece{s.pending === 1 ? "" : "s"} of gear.</>}
          {s.distance != null && (
            <div style={{ color: "var(--bone-faint)", fontSize: "var(--fs-eyebrow)", marginTop: "2px" }}>
              {Math.round(s.distance)}m away
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
