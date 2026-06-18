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
      // Stacked above the SkillBar (which owns the 1–4 keys). This is a
      // mouse-driven consumable quick-bar — no keyboard slot labels, since
      // those number keys activate skills, not hotbar items.
      position: "fixed", bottom: "92px", left: "50%",
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
