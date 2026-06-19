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
import { dragSystem } from "../drag_system.ts";
import type { Recipe } from "@voxim/content";
import { contentService } from "../content_ref.ts";
import type { UIAction } from "../ui_actions.ts";
import { Pane, Slot, Section } from "./primitives.tsx";
import { humanizeItemType } from "../item_names.ts";

const workstation = computed(() => uiState.value.workstation);

// ---- recipe matching ------------------------------------------------------

type RecipeInput = Recipe["inputs"][number];

function inputAccepts(input: RecipeInput, prefabId: string): boolean {
  if ("itemType" in input && input.itemType !== undefined) return prefabId === input.itemType;
  if ("category" in input && input.category !== undefined) {
    const svc = contentService.value;
    const p = svc?.prefabs.get(prefabId);
    if (!p || p.category !== input.category) return false;
    if (input.tags) {
      const have = p.tags ?? [];
      for (const t of input.tags) if (!have.includes(t)) return false;
    }
    return true;
  }
  return false;
}

function inputSpecificity(input: RecipeInput): number {
  if ("itemType" in input && input.itemType !== undefined) return 2;
  if ("tags" in input && (input.tags?.length ?? 0) > 0) return 1;
  return 0;
}

function slotPrefab(slot: WorkstationBufferSlotView): string {
  return slot.kind === "stack" ? slot.itemType : slot.prefabId;
}
function slotQty(slot: WorkstationBufferSlotView): number {
  return slot.kind === "stack" ? slot.quantity : 1;
}

function recipeMatches(recipe: Recipe, slots: readonly (WorkstationBufferSlotView | null)[]): boolean {
  const ordered = [...recipe.inputs].sort((a, b) => inputSpecificity(b) - inputSpecificity(a));
  const claimed = new Set<number>();
  for (const input of ordered) {
    let ok = false;
    for (let i = 0; i < slots.length; i++) {
      if (claimed.has(i)) continue;
      const slot = slots[i];
      if (!slot) continue;
      if (slotQty(slot) < input.quantity) continue;
      if (!inputAccepts(input, slotPrefab(slot))) continue;
      claimed.add(i);
      ok = true;
      break;
    }
    if (!ok) return false;
  }
  return true;
}

/** Every recipe craftable at this station type — the browse list (T-091). */
function findStationRecipes(panel: WorkstationPanelState): Recipe[] {
  const svc = contentService.value;
  if (!svc) return [];
  const out: Recipe[] = [];
  for (const r of svc.recipes.values()) {
    if (r.stationType === panel.stationType) out.push(r);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** "1× Iron Ore + 1× Coal" — the recipe's inputs as a human hint. */
function inputSummary(recipe: Recipe): string {
  return recipe.inputs
    .map((i) => {
      const label = "itemType" in i && i.itemType !== undefined
        ? humanizeItemType(i.itemType)
        : ("category" in i && i.category !== undefined ? i.category : "any");
      return `${i.quantity}× ${label}`;
    })
    .join(" + ");
}

/** "2× Iron Ingot" — the recipe's outputs as a human label. */
function outputLabel(recipe: Recipe): string {
  return recipe.outputs
    .map((o) => `${o.quantity}× ${humanizeItemType(o.itemType)}`)
    .join(", ");
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

  const handleMouseDown = (e: MouseEvent) => {
    if (!slot) return;
    const id = slotPrefab(slot);
    const qty = slotQty(slot);
    const stack: ItemStack = {
      itemType: id, quantity: qty,
      displayName: id, modelTemplateId: null,
    };
    dragSystem.startDrag(stack, "workstation", index, e.currentTarget as HTMLElement, () => {
      onAction({ type: "take_workstation", bufferSlot: index });
    });
  };

  const highlight = drop && uiState.value.drag?.sourceKind === "inventory";
  const id = slot ? slotPrefab(slot) : "";
  const qty = slot ? slotQty(slot) : 0;

  return (
    <Slot
      elRef={elRef}
      empty={!slot}
      dragover={highlight}
      title={id}
      onMouseDown={handleMouseDown}
    >
      {slot && <span class="slot-glyph">{id.slice(0, 1).toUpperCase()}</span>}
      {slot && qty > 1 && <span class="slot-qty">{qty}</span>}
    </Slot>
  );
}

// ---- recipe row -----------------------------------------------------------

/**
 * One selectable recipe in the browser. Clicking dispatches `select_recipe`
 * (→ CommandType.SelectRecipe), locking it as the station's `activeRecipeId`.
 * `ready` (buffer already satisfies the inputs) shows an ember dot; `active`
 * (the locked recipe) gets a highlighted border.
 */
function RecipeRow({ recipe, active, ready, onSelect }: {
  recipe: Recipe;
  active: boolean;
  ready: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      class="btn interactive"
      onClick={onSelect}
      title={inputSummary(recipe)}
      style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: "var(--s-2)", padding: "3px 8px", textAlign: "left", width: "100%",
        fontSize: "var(--fs-body)",
        border: active ? "1px solid var(--ember-hi)" : "1px solid var(--line)",
        color: active ? "var(--ember-hi)" : "var(--bone)",
      }}
    >
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {outputLabel(recipe)}
        </span>
        <span style={{ color: "var(--bone-faint)", fontSize: "var(--fs-eyebrow)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {inputSummary(recipe)}
        </span>
      </span>
      <span style={{ color: ready ? "var(--ember-hi)" : "var(--line-strong)", flex: "0 0 auto" }}>
        {ready ? "●" : "○"}
      </span>
    </button>
  );
}

// ---- panel ----------------------------------------------------------------

export function WorkstationPanel({ onAction }: { onAction: (a: UIAction) => void }) {
  const ws = workstation.value;
  if (!ws) return null;

  const recipes = findStationRecipes(ws);
  const slots: (WorkstationBufferSlotView | null)[] = [...ws.slots];
  while (slots.length < ws.capacity) slots.push(null);

  const cols = Math.min(4, ws.capacity);

  return (
    <Pane
      title={ws.stationType}
      defaultX={460} defaultY={80}
      onClose={() => closePanel("workstation")}
      style={{ width: "320px" }}
    >
      <Section title="Buffer">
        <div style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, var(--cell))`,
          gap: "1px",
          background: "var(--line)",
          padding: "1px",
          border: "1px solid var(--line-strong)",
          justifyContent: "start",
        }}>
          {slots.map((slot, i) => (
            <BufferSlotCell key={i} slot={slot} index={i} onAction={onAction} />
          ))}
        </div>
      </Section>

      {ws.activeRecipeId && (
        <div style={{
          fontSize: "var(--fs-eyebrow)",
          letterSpacing: "var(--ls-eyebrow)",
          textTransform: "uppercase",
          color: "var(--ember-hi)",
          fontFamily: "var(--font-mono)",
        }}>
          Crafting: {humanizeItemType(ws.activeRecipeId)}
        </div>
      )}

      <Section title="Recipes" hint={`${recipes.length}`}>
        {recipes.length === 0
          ? <span style={{ color: "var(--bone-faint)", fontSize: "var(--fs-body)" }}>No recipes at this station.</span>
          : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-1)" }}>
              {recipes.map((r) => (
                <RecipeRow
                  key={r.id}
                  recipe={r}
                  active={ws.activeRecipeId === r.id}
                  ready={recipeMatches(r, ws.slots)}
                  onSelect={() => onAction({ type: "select_recipe", recipeId: r.id })}
                />
              ))}
            </div>
          )
        }
      </Section>
    </Pane>
  );
}
