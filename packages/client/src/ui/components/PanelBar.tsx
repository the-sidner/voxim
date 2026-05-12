import { uiState, openPanel, closePanel } from "../ui_store.ts";
import type { PanelId } from "../ui_store.ts";
import { Btn, Kbd } from "./primitives.tsx";

interface PanelBtn {
  id: PanelId;
  label: string;
  key: string;
}

const BUTTONS: PanelBtn[] = [
  { id: "inventory",  label: "Inventory", key: "I" },
  { id: "equipment",  label: "Equipment", key: "E" },
  { id: "stats",      label: "Stats",     key: "C" },
  { id: "debug",      label: "Debug",     key: "`" },
];

export function PanelBar() {
  const panels = uiState.value.openPanels;

  return (
    <div class="interactive" style={{
      position: "fixed", top: "var(--s-4)", left: "var(--s-4)",
      display: "flex", gap: "var(--s-2)",
      zIndex: "var(--z-hud)",
    }}>
      {BUTTONS.map(({ id, label, key }) => {
        const active = panels.has(id);
        return (
          <Btn
            key={id}
            active={active}
            title={`${label} [${key}]`}
            onClick={() => active ? closePanel(id) : openPanel(id)}
          >
            <Kbd>{key}</Kbd>{label}
          </Btn>
        );
      })}
    </div>
  );
}
