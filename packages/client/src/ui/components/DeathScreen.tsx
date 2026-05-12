import type { UIAction } from "../ui_actions.ts";
import { Btn } from "./primitives.tsx";

export function DeathScreen({ onAction }: { onAction: (a: UIAction) => void }) {
  return (
    <div
      class="interactive"
      style={{
        position: "fixed", inset: "0",
        background: "rgba(7, 6, 3, 0.78)",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        gap: "var(--s-7)",
        zIndex: "var(--z-modal)",
      }}
    >
      <div class="ds-display" style={{ color: "var(--rot)", textTransform: "uppercase", letterSpacing: "0.24em" }}>
        You Died
      </div>
      {/* TODO: show death stats (damage taken, kill source, time survived) */}
      <Btn kind="primary" onClick={() => onAction({ type: "respawn" })}>
        Respawn
      </Btn>
    </div>
  );
}
