import type { UIAction } from "../ui_actions.ts";

// TODO: read keybindings from a signal populated by InputController

export function SettingsPanel({ onAction: _onAction }: { onAction: (a: UIAction) => void }) {
  return (
    <div
      class="panel interactive"
      style={{
        position: "absolute", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: "var(--z-modal)",
        width: "320px",
      }}
    >
      <div class="panel__title">Settings</div>

      <div class="panel__title" style={{ marginTop: "var(--gap-sm)" }}>Keybindings</div>
      {/* TODO: iterate keybinding map from InputController and render rebindable rows */}
      <div style={{ fontSize: "var(--text-sm)", color: "var(--col-text-dim)" }}>
        (keybinding list — not yet implemented)
      </div>

      <div class="panel__title" style={{ marginTop: "var(--gap-sm)" }}>Graphics</div>
      {/* TODO: render quality / resolution controls */}
      <div style={{ fontSize: "var(--text-sm)", color: "var(--col-text-dim)" }}>
        (graphics options — not yet implemented)
      </div>
    </div>
  );
}
