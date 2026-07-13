import { computed } from "@preact/signals";
import { useRef, useEffect, useState } from "preact/hooks";
import { uiState, patchUI, hotbarItems } from "../ui_store.ts";
import { dragSystem } from "../drag_system.ts";
import type { UIAction } from "../ui_actions.ts";
import type { ContextMenuAction, ItemStack } from "../ui_store.ts";
import { Slot } from "./primitives.tsx";

const hotbar = computed(() => uiState.value.hotbar);

function HotbarSlotCell({ item, index, active, onAction }: {
  item: ItemStack | null;
  index: number;
  active: boolean;
  onAction: (a: UIAction) => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [dropHighlight, setDropHighlight] = useState(false);

  // Drop target: assign whatever inventory item is dragged onto this slot
  // (T-309 prerequisite). Mirrors EquipmentPanel's EquipSlot registration.
  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const zoneId = `hotbar:${index}`;
    dragSystem.registerZone(el, zoneId, {
      accept: ["inventory"],
      onDrop: (drag) => {
        onAction({ type: "hotbar_assign", inventorySlot: drag.sourceIndex, hotbarSlot: index });
        dragSystem.endDrag();
      },
      onEnter: () => setDropHighlight(true),
      onLeave: () => setDropHighlight(false),
    });
    return () => {
      dragSystem.unregisterZone(zoneId);
      setDropHighlight(false);
    };
  }, [index]);

  const handleContextMenu = (e: MouseEvent) => {
    if (!item) return;
    e.preventDefault();
    const actions: ContextMenuAction[] = [
      { label: "Clear", danger: true, onSelect: () => onAction({ type: "hotbar_clear", hotbarSlot: index }) },
    ];
    patchUI({ contextMenu: { screenX: e.clientX, screenY: e.clientY, actions } });
  };

  const highlight = dropHighlight && uiState.value.drag?.sourceKind === "inventory";

  return (
    <Slot
      elRef={slotRef}
      empty={!item}
      active={active}
      dragover={highlight}
      title={item?.displayName ?? ""}
      onClick={() => item && onAction({ type: "hotbar_use", hotbarSlot: index })}
      onContextMenu={handleContextMenu}
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
  );
}

export function Hotbar({ onAction }: { onAction: (a: UIAction) => void }) {
  const hb = hotbar.value;
  if (!hb) return null;
  const items = hotbarItems.value;

  // Row of the shared bottom `.action-frame` dock (ui_manager.tsx, T-314),
  // stacked above the SkillBar (which owns the 1–4 keys) within it. This is
  // a mouse-driven consumable quick-bar — no keyboard slot labels, since
  // those number keys activate skills, not hotbar items.
  return (
    <div class="hotbar interactive">
      {items.map((item, i) => (
        <HotbarSlotCell key={i} item={item} index={i} active={i === hb.activeIndex} onAction={onAction} />
      ))}
    </div>
  );
}
