import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";
import type { UIAction } from "../ui_actions.ts";

const crafting = computed(() => uiState.value.crafting);

export function CraftingPanel({ onAction }: { onAction: (a: UIAction) => void }) {
  const cr = crafting.value;
  if (!cr) return null;

  return (
    <div
      class="panel interactive"
      style={{
        position: "absolute", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: "var(--z-panel)",
        width: "280px",
      }}
    >
      <div class="panel__title">Crafting</div>

      {/* Input slots — drag items here from inventory */}
      <div style={{ display: "flex", gap: "var(--gap-xs)", marginBottom: "var(--gap-sm)" }}>
        {cr.inputSlots.map((slot) => (
          <div
            key={slot.index}
            class={`slot interactive ${slot.item ? "" : "slot--empty"}`}
            title={slot.item?.displayName ?? ""}
            onClick={() => slot.item && onAction({ type: "crafting_remove", craftingSlot: slot.index })}
          >
            {/* TODO: item icon */}
            {slot.item && <span style={{ fontSize: "var(--text-xs)" }}>{slot.item.displayName.slice(0, 4)}</span>}
          </div>
        ))}
      </div>

      {/* Matched recipe & output */}
      {cr.matchedRecipeId && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--col-text-dim)", marginBottom: "var(--gap-xs)" }}>
          Recipe: {cr.matchedRecipeId}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "var(--gap-sm)" }}>
        <div class={`slot ${cr.outputSlot ? "" : "slot--empty"}`}>
          {cr.outputSlot && <span style={{ fontSize: "var(--text-xs)" }}>{cr.outputSlot.displayName.slice(0, 4)}</span>}
        </div>
        <button
          class="btn btn--primary interactive"
          disabled={!cr.matchedRecipeId}
          onClick={() => onAction({ type: "crafting_craft" })}
        >
          Craft
        </button>
      </div>
    </div>
  );
}
