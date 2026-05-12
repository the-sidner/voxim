import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";

const toasts = computed(() => uiState.value.toasts);

export function ToastQueue() {
  return (
    <div style={{
      position: "fixed", top: "var(--s-6)", left: "var(--s-6)",
      display: "flex", flexDirection: "column", gap: "var(--s-2)",
      zIndex: "var(--z-toast)",
      pointerEvents: "none",
    }}>
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast toast--${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
