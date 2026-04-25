import { computed } from "@preact/signals";
import { uiState, patchUI } from "../ui_store.ts";
import { usePanel } from "../use_panel.ts";
import { dragSystem } from "../drag_system.ts";
import type { UIAction } from "../ui_actions.ts";
import type { ContextMenuAction, ItemStack } from "../ui_store.ts";
import { item_prefabs as itemPrefabsData } from "@voxim/content";

const inventory = computed(() => uiState.value.inventory);

// Index built once at module load so context menus don't scan all 450 prefabs
// per right-click. Maps prefabId → true when the item carries a `deployable`
// component; the server will reject any Place/source=inventory call for items
// that aren't in this set, so this is purely a UX gate to hide the option.
const DEPLOYABLE_PREFABS: ReadonlySet<string> = new Set(
  itemPrefabsData.filter((p) => "deployable" in p.components).map((p) => p.id),
);

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
    if (DEPLOYABLE_PREFABS.has(item.itemType)) {
      actions.push({ label: "Place", onSelect: () => onAction({ type: "deploy_item", fromSlot: index }) });
    }
    actions.push({ label: "Drop", danger: true, onSelect: () => onAction({ type: "drop_item", fromSlot: index }) });
    patchUI({
      contextMenu: { screenX: e.clientX, screenY: e.clientY, actions },
    });
  };

  return (
    <div
      class={`slot interactive ${item ? "" : "slot--empty"}`}
      title={item?.displayName ?? ""}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      onMouseEnter={(e) => item && patchUI({
        tooltip: { item, screenX: (e.target as HTMLElement).getBoundingClientRect().right, screenY: (e.target as HTMLElement).getBoundingClientRect().top },
      })}
      onMouseLeave={() => patchUI({ tooltip: null })}
    >
      {/* TODO: render item icon */}
      {item && (
        <span style={{ fontSize: "var(--text-xs)", textAlign: "center", wordBreak: "break-all" }}>
          {item.displayName.slice(0, 4)}
          {item.quantity > 1 && (
            <sup style={{ color: "var(--col-accent)", fontSize: "8px" }}>{item.quantity}</sup>
          )}
        </span>
      )}
    </div>
  );
}

export function InventoryPanel({ onAction }: { onAction: (a: UIAction) => void }) {
  const inv = inventory.value;
  if (!inv) return null;
  const { panelProps, titleProps } = usePanel({ defaultX: 220, defaultY: 80 });

  return (
    <div class="panel interactive" {...panelProps} style={{ ...panelProps.style, width: "220px" }}>
      <div class="panel__title" {...titleProps}>Inventory</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--gap-xs)" }}>
        {inv.slots.map((item, i) => (
          <ItemSlotCell key={i} item={item} index={i} onAction={onAction} />
        ))}
      </div>
    </div>
  );
}
