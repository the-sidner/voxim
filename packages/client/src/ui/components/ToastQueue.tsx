import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";

const toasts = computed(() => uiState.value.toasts);

export function ToastQueue() {
  return (
    <div style={{
      position: "absolute", top: "var(--gap-lg)", right: "var(--gap-lg)",
      display: "flex", flexDirection: "column", gap: "var(--gap-xs)",
      zIndex: "var(--z-toast)",
    }}>
      {toasts.value.map((t) => (
        <div
          key={t.id}
          class={`panel toast toast--${t.kind}`}
          style={{ fontSize: "var(--text-sm)", padding: "var(--gap-xs) var(--gap-sm)" }}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
