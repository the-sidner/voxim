import { computed } from "@preact/signals";
import { uiState, patchUI } from "../ui_store.ts";
import type { UIAction } from "../ui_actions.ts";

const contextMenu = computed(() => uiState.value.contextMenu);

export function ContextMenu({ onAction: _onAction }: { onAction: (a: UIAction) => void }) {
  const menu = contextMenu.value;
  if (!menu) return null;

  const close = () => patchUI({ contextMenu: null });

  return (
    <>
      {/* Invisible backdrop to catch outside clicks */}
      <div
        class="interactive"
        style={{ position: "fixed", inset: "0", zIndex: "calc(var(--z-context) - 1)" }}
        onClick={close}
      />
      <div
        class="panel interactive"
        style={{
          position: "fixed",
          left: `${menu.screenX}px`,
          top:  `${menu.screenY}px`,
          zIndex: "var(--z-context)",
          minWidth: "140px",
          padding: "var(--gap-xs)",
        }}
      >
        {menu.actions.map((action, i) => (
          <div
            key={i}
            class="interactive"
            style={{
              padding: "var(--gap-xs) var(--gap-sm)",
              cursor: "pointer",
              borderRadius: "var(--radius-sm)",
              color: action.danger ? "var(--col-danger)" : "var(--col-text)",
              fontSize: "var(--text-sm)",
            }}
            onClick={() => { action.onSelect(); close(); }}
          >
            {action.label}
          </div>
        ))}
      </div>
    </>
  );
}
