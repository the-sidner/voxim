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
      {/* Invisible backdrop catches outside clicks. */}
      <div
        class="interactive"
        style={{ position: "fixed", inset: "0", zIndex: "calc(var(--z-context) - 1)" }}
        onClick={close}
      />
      <div
        class="ctxmenu interactive"
        style={{ left: `${menu.screenX}px`, top: `${menu.screenY}px` }}
      >
        {menu.actions.map((action, i) => (
          <div
            key={i}
            class={`item interactive ${action.danger ? "danger" : ""}`}
            onClick={() => { action.onSelect(); close(); }}
          >
            <span>{action.label}</span>
          </div>
        ))}
      </div>
    </>
  );
}
