import type { UIAction } from "../ui_actions.ts";
import { closePanel } from "../ui_store.ts";
import { Pane, Section } from "./primitives.tsx";

// TODO: read keybindings from a signal populated by InputController

export function SettingsPanel({ onAction: _onAction }: { onAction: (a: UIAction) => void }) {
  return (
    <Pane
      title="Settings"
      defaultX={window.innerWidth / 2 - 180}
      defaultY={window.innerHeight / 2 - 200}
      onClose={() => closePanel("settings")}
      style={{ width: "360px", zIndex: "var(--z-modal)" }}
    >
      <Section title="Keybindings">
        <div class="flavour">(keybinding list — not yet implemented)</div>
      </Section>
      <Section title="Graphics">
        <div class="flavour">(graphics options — not yet implemented)</div>
      </Section>
    </Pane>
  );
}
