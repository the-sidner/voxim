import type { UIAction } from "../ui_actions.ts";

export function DeathScreen({ onAction }: { onAction: (a: UIAction) => void }) {
  return (
    <div
      class="interactive"
      style={{
        position: "fixed", inset: "0",
        background: "rgba(0,0,0,0.72)",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        zIndex: "var(--z-modal)",
      }}
    >
      <div style={{
        fontSize: "var(--text-xl)",
        color: "var(--col-danger)",
        letterSpacing: "0.2em",
        marginBottom: "var(--gap-xl)",
        textTransform: "uppercase",
      }}>
        You Died
      </div>
      {/* TODO: show death stats (damage taken, kill source, time survived) */}
      <button
        class="btn btn--primary interactive"
        onClick={() => onAction({ type: "respawn" })}
      >
        Respawn
      </button>
    </div>
  );
}
