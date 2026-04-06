import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";

const tooltip = computed(() => uiState.value.tooltip);

export function TooltipPortal() {
  const t = tooltip.value;
  if (!t) return null;

  return (
    <div
      class="panel"
      style={{
        position: "fixed",
        left: `${t.screenX + 16}px`,
        top:  `${t.screenY}px`,
        zIndex: "var(--z-tooltip)",
        minWidth: "160px",
        maxWidth: "240px",
        boxShadow: "var(--shadow-tooltip)",
        pointerEvents: "none",
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: "var(--gap-xs)" }}>
        {t.item.displayName}
      </div>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--col-text-dim)" }}>
        {t.item.itemType}
      </div>
      {/* TODO: render derived stats (damage, weight, material breakdown) */}
    </div>
  );
}
