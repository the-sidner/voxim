import { uiState, openPanel, closePanel } from "../ui_store.ts";
import type { PanelId } from "../ui_store.ts";

interface PanelBtn {
  id: PanelId;
  label: string;
  key: string;
}

const BUTTONS: PanelBtn[] = [
  { id: "inventory",  label: "Inv",  key: "I" },
  { id: "equipment",  label: "Eqp",  key: "E" },
  { id: "stats",      label: "Sts",  key: "C" },
  { id: "debug",      label: "Dbg",  key: "`" },
];

export function PanelBar() {
  const panels = uiState.value.openPanels;

  return (
    <div class="interactive" style={{
      position: "fixed", top: "12px", right: "12px",
      display: "flex", gap: "var(--gap-xs)",
      zIndex: "var(--z-hud)",
    }}>
      {BUTTONS.map(({ id, label, key }) => {
        const active = panels.has(id);
        return (
          <button
            key={id}
            class={`btn${active ? " btn--active" : ""}`}
            title={`${label} [${key}]`}
            onClick={() => active ? closePanel(id) : openPanel(id)}
            style={{ minWidth: "42px" }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
