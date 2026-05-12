import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";
import type { UIAction } from "../ui_actions.ts";
import { Slot } from "./primitives.tsx";

const hotbar = computed(() => uiState.value.hotbar);

export function Hotbar({ onAction }: { onAction: (a: UIAction) => void }) {
  const hb = hotbar.value;
  if (!hb) return null;

  return (
    <div class="hotbar interactive" style={{
      position: "fixed", bottom: "36px", left: "50%",
      transform: "translateX(-50%)",
      zIndex: "var(--z-hud)",
    }}>
      {hb.slots.map((item, i) => (
        <Slot
          key={i}
          empty={!item}
          active={i === hb.activeIndex}
          title={item?.displayName ?? ""}
          onClick={() => item && onAction({ type: "hotbar_use", hotbarSlot: i })}
        >
          <span class="slot-key">{i + 1}</span>
          {item && (
            <span class="slot-glyph">
              {item.displayName.slice(0, 1).toUpperCase()}
            </span>
          )}
          {item && item.quantity > 1 && (
            <span class="slot-qty">{item.quantity}</span>
          )}
        </Slot>
      ))}
    </div>
  );
}
