/// <reference lib="dom" />
/**
 * WorkstationPanel — buffer + matched-recipe view for the workstation the
 * player just clicked.
 *
 * Open/close is driven by uiState.workstation (set by game.ts on click,
 * cleared by closePanel("workstation")). game.ts mirrors the live buffer +
 * tag here on every state message that touches the open entity, so the panel
 * stays purely reactive.
 *
 * Recipes auto-resolve from buffer contents — no preselect. The matching
 * algorithm mirrors `findMatchingRecipe` on the server: filter by stationType,
 * then check that every input is satisfied (primary or alternate item) by
 * the current buffer.
 */
import { computed } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { uiState, closePanel, type ItemStack, type WorkstationBufferSlotView, type WorkstationPanelState } from "../ui_store.ts";
import { usePanel } from "../use_panel.ts";
import { dragSystem } from "../drag_system.ts";
import { recipes as recipesData } from "@voxim/content";
import type { Recipe } from "@voxim/content";
import type { UIAction } from "../ui_actions.ts";

const workstation = computed(() => uiState.value.workstation);

// ---- recipe matching ------------------------------------------------------

function recipeMatches(recipe: Recipe, totals: Map<string, number>): boolean {
  return recipe.inputs.every((inp) => {
    if ((totals.get(inp.itemType) ?? 0) >= inp.quantity) return true;
    if (inp.alternates) {
      for (const alt of inp.alternates) if ((totals.get(alt) ?? 0) >= inp.quantity) return true;
    }
    return false;
  });
}

function findMatchingRecipes(panel: WorkstationPanelState): Recipe[] {
  const totals = new Map<string, number>();
  for (const s of panel.slots) if (s) totals.set(s.itemType, (totals.get(s.itemType) ?? 0) + s.quantity);
  return recipesData.filter((r) =>
    r.stationType === panel.stationType && recipeMatches(r, totals),
  );
}

// ---- buffer slot cell -----------------------------------------------------

function BufferSlotCell({
  slot, index, onAction,
}: {
  slot: WorkstationBufferSlotView | null;
  index: number;
  onAction: (a: UIAction) => void;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState(false);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const zoneId = `workstation:${index}`;
    dragSystem.registerZone(el, zoneId, {
      accept: ["inventory"],
      onDrop: (drag) => {
        onAction({ type: "load_workstation", inventorySlot: drag.sourceIndex, bufferSlot: index });
        dragSystem.endDrag();
      },
      onEnter: () => setDrop(true),
      onLeave: () => setDrop(false),
    });
    return () => { dragSystem.unregisterZone(zoneId); setDrop(false); };
  }, [index]);

  // Source: drag from the buffer back into inventory. Drop-outside fires take.
  const handleMouseDown = (e: MouseEvent) => {
    if (!slot) return;
    const stack: ItemStack = {
      itemType: slot.itemType, quantity: slot.quantity,
      displayName: slot.itemType, modelTemplateId: null,
    };
    dragSystem.startDrag(stack, "workstation", index, e.currentTarget as HTMLElement, () => {
      onAction({ type: "take_workstation", bufferSlot: index });
    });
  };

  const highlight = drop && uiState.value.drag?.sourceKind === "inventory";

  return (
    <div
      ref={elRef}
      class={`slot interactive ${slot ? "" : "slot--empty"}`}
      style={highlight ? { outline: "2px solid var(--col-accent)", outlineOffset: "2px" } : undefined}
      title={slot?.itemType ?? ""}
      onMouseDown={handleMouseDown}
    >
      {slot && (
        <span style={{ fontSize: "var(--text-xs)", textAlign: "center" }}>
          {slot.itemType.slice(0, 4)}
          <sup style={{ color: "var(--col-accent)", fontSize: "8px" }}>{slot.quantity}</sup>
        </span>
      )}
    </div>
  );
}

// ---- panel ----------------------------------------------------------------

export function WorkstationPanel({ onAction }: { onAction: (a: UIAction) => void }) {
  const ws = workstation.value;
  const { panelProps, titleProps } = usePanel({ defaultX: 460, defaultY: 80 });
  if (!ws) return null;

  const matches = findMatchingRecipes(ws);
  const slots: (WorkstationBufferSlotView | null)[] = [...ws.slots];
  while (slots.length < ws.capacity) slots.push(null);

  return (
    <div class="panel interactive" {...panelProps} style={{ ...panelProps.style, width: "260px" }}>
      <div class="panel__title" {...titleProps}>
        {ws.stationType}
        <button
          class="interactive"
          style={{ float: "right", background: "transparent", border: "none", color: "var(--col-text-dim)", cursor: "pointer" }}
          onClick={() => closePanel("workstation")}
        >×</button>
      </div>

      {/* Buffer slot grid — drag inventory items here to load, drag away to take. */}
      <div style={{
        display: "grid",
        gridTemplateColumns: `repeat(${Math.min(4, ws.capacity)}, 1fr)`,
        gap: "var(--gap-xs)",
        marginBottom: "var(--gap-sm)",
      }}>
        {slots.map((slot, i) => (
          <BufferSlotCell key={i} slot={slot} index={i} onAction={onAction} />
        ))}
      </div>

      {/* Active recipe progress (time-step only). */}
      {ws.activeRecipeId && ws.progressTicks !== null && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--col-text-dim)", marginBottom: "var(--gap-xs)" }}>
          Crafting: {ws.activeRecipeId} ({ws.progressTicks}t remaining)
        </div>
      )}

      {/* Matched recipes — derived from buffer contents, not preselected. */}
      <div style={{ fontSize: "var(--text-xs)", color: "var(--col-text-dim)" }}>
        {matches.length === 0
          ? "No matching recipe."
          : `Matches (${matches.length}): ${matches.map((r) => r.id).join(", ")}`}
      </div>
    </div>
  );
}
