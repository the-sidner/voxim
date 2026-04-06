import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";
import type { UIAction } from "../ui_actions.ts";

const hotbar = computed(() => uiState.value.hotbar);

export function Hotbar({ onAction }: { onAction: (a: UIAction) => void }) {
  const hb = hotbar.value;
  if (!hb) return null;

  return (
    <div class="interactive" style={{
      position: "fixed", bottom: "80px", left: "50%",
      transform: "translateX(-50%)",
      display: "flex", gap: "var(--gap-xs)",
      zIndex: "var(--z-hud)",
    }}>
      {hb.slots.map((item, i) => (
        <div
          key={i}
          class={`slot ${i === hb.activeIndex ? "slot--active" : ""} ${!item ? "slot--empty" : ""}`}
          title={item?.displayName ?? ""}
          onClick={() => item && onAction({ type: "hotbar_use", hotbarSlot: i })}
        >
          {/* TODO: render item icon */}
          <span style={{ fontSize: "var(--text-xs)", color: "var(--col-text-dim)" }}>
            {i + 1}
          </span>
        </div>
      ))}
    </div>
  );
}
