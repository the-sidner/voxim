import { computed } from "@preact/signals";
import { uiState, patchUI, closePanel } from "../ui_store.ts";
import { dragSystem } from "../drag_system.ts";
import { clientWorld } from "../client_world_ref.ts";
import { contentService } from "../content_ref.ts";
import type { UIAction } from "../ui_actions.ts";
import type { ContextMenuAction, ItemStack } from "../ui_store.ts";
import { Pane, Slot, Kbd } from "./primitives.tsx";

const inventory = computed(() => uiState.value.inventory);

// Reactive index of deployable prefabs (T-177 phase 3): rebuilds when the
// bootstrap-delivered ContentService swaps in (initial connect, tile
// transition). Empty until the bootstrap blob arrives.
const deployablePrefabs = computed<ReadonlySet<string>>(() => {
  const svc = contentService.value;
  if (!svc) return new Set();
  const out = new Set<string>();
  for (const p of svc.prefabs.values()) {
    if ("deployable" in p.components) out.add(p.id);
  }
  return out;
});

// First letter of the item, displayed inside the cell. Replace with proper
// rune / SVG glyph dictionary once content lands per-prefab icons.
function glyphFor(item: ItemStack): string {
  return item.displayName.slice(0, 1).toUpperCase();
}

function ItemSlotCell({ item, index, onAction }: {
  item: ItemStack | null;
  index: number;
  onAction: (a: UIAction) => void;
}) {
  const handleMouseDown = (e: MouseEvent) => {
    if (!item) return;
    dragSystem.startDrag(item, "inventory", index, e.currentTarget as HTMLElement);
  };

  const handleContextMenu = (e: MouseEvent) => {
    if (!item) return;
    e.preventDefault();
    const actions: ContextMenuAction[] = [
      { label: "Use",   onSelect: () => onAction({ type: "use_item",  fromSlot: index }) },
      { label: "Equip", onSelect: () => onAction({ type: "equip", itemType: item.itemType, fromSlot: index }) },
    ];
    if (deployablePrefabs.value.has(item.itemType)) {
      actions.push({ label: "Place", onSelect: () => onAction({ type: "deploy_item", fromSlot: index }) });
    }
    actions.push({ label: "Drop", danger: true, onSelect: () => onAction({ type: "drop_item", fromSlot: index }) });
    patchUI({
      contextMenu: { screenX: e.clientX, screenY: e.clientY, actions },
    });
  };

  return (
    <Slot
      empty={!item}
      title={item?.displayName ?? ""}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      onMouseEnter={(e) => {
        if (!item) return;
        // Unique items carry per-instance Stats / Provenance on their entity;
        // pull both at hover time so the tooltip reflects current state.
        const entity = item.entityId ? clientWorld.value?.get(item.entityId) : null;
        const rect = (e.target as HTMLElement).getBoundingClientRect();
        patchUI({
          tooltip: {
            item,
            screenX: rect.right,
            screenY: rect.top,
            stats: entity?.stats,
            provenance: entity?.provenance,
          },
        });
      }}
      onMouseLeave={() => patchUI({ tooltip: null })}
    >
      {item && <span class="slot-glyph">{glyphFor(item)}</span>}
      {item && item.quantity > 1 && (
        <span class="slot-qty">{item.quantity}</span>
      )}
    </Slot>
  );
}

export function InventoryPanel({ onAction }: { onAction: (a: UIAction) => void }) {
  const inv = inventory.value;
  if (!inv) return null;

  return (
    <Pane
      title="Burden"
      defaultX={220} defaultY={80}
      onClose={() => closePanel("inventory")}
      style={{ width: "320px" }}
      foot={
        <>
          <span><Kbd>I</Kbd>burden</span>
          <span class="num">{inv.slots.filter((s) => s).length} / {inv.slots.length}</span>
        </>
      }
    >
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(8, var(--cell))",
        gap: "1px",
        background: "var(--line)",
        padding: "1px",
        border: "1px solid var(--line-strong)",
        justifyContent: "center",
      }}>
        {inv.slots.map((item, i) => (
          <ItemSlotCell key={i} item={item} index={i} onAction={onAction} />
        ))}
      </div>
    </Pane>
  );
}
