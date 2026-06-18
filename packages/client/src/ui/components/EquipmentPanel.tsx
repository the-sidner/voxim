import { computed } from "@preact/signals";
import { useRef, useEffect, useState } from "preact/hooks";
import { uiState, closePanel } from "../ui_store.ts";
import { dragSystem } from "../drag_system.ts";
import type { UIAction } from "../ui_actions.ts";
import type { ItemStack } from "../ui_store.ts";
import { Pane, Slot } from "./primitives.tsx";

const equipment = computed(() => uiState.value.equipment);

// Equipment slot runes. The empty cell shows the rune at low contrast so the
// player knows what goes where without a popup.
const SLOT_RUNE: Record<string, string> = {
  head:    "ʘ",
  chest:   "✦",
  legs:    "⫿",
  feet:    "⩙",
  weapon:  "†",
  offHand: "○",
  back:    "⌇",
};

function EquipSlot({ item, slot, onAction }: {
  item: ItemStack | null;
  slot: string;
  onAction: (a: UIAction) => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [dropHighlight, setDropHighlight] = useState(false);

  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const zoneId = `equipment:${slot}`;
    dragSystem.registerZone(el, zoneId, {
      accept: ["inventory"],
      onDrop: (drag) => {
        onAction({ type: "equip", itemType: drag.item.itemType, fromSlot: drag.sourceIndex });
        dragSystem.endDrag();
      },
      onEnter: () => setDropHighlight(true),
      onLeave: () => setDropHighlight(false),
    });
    return () => {
      dragSystem.unregisterZone(zoneId);
      setDropHighlight(false);
    };
  }, [slot]);

  const handleMouseDown = (e: MouseEvent) => {
    if (!item) return;
    dragSystem.startDrag(item, "equipment", 0, e.currentTarget as HTMLElement, () => {
      onAction({ type: "unequip", slot });
    });
  };

  const highlight = dropHighlight && uiState.value.drag?.sourceKind === "inventory";

  return (
    <Slot
      elRef={slotRef}
      empty={!item}
      dragover={highlight}
      title={item?.displayName ?? slot}
      onMouseDown={handleMouseDown}
      onClick={() => item && !uiState.value.drag && onAction({ type: "unequip", slot })}
    >
      {item
        ? <span class="slot-glyph">{item.displayName.slice(0, 1).toUpperCase()}</span>
        : <span class="slot-glyph" style={{ color: "var(--bone-ghost)" }}>{SLOT_RUNE[slot] ?? "·"}</span>
      }
    </Slot>
  );
}

// Body-doll geometry — slots laid out around the silhouette.
const DOLL_LAYOUT: Record<string, { row: number; col: number }> = {
  head:    { row: 1, col: 2 },
  back:    { row: 2, col: 1 },
  chest:   { row: 2, col: 2 },
  weapon:  { row: 2, col: 3 },
  legs:    { row: 3, col: 2 },
  offHand: { row: 3, col: 3 },
  feet:    { row: 4, col: 2 },
};

export function EquipmentPanel({ onAction }: { onAction: (a: UIAction) => void }) {
  const eq = equipment.value;
  if (!eq) return null;

  return (
    <Pane
      title="Worn"
      defaultX={20} defaultY={80}
      onClose={() => closePanel("equipment")}
      style={{ width: "200px" }}
    >
      <div style={{
        display: "grid",
        gridTemplateColumns: "var(--cell) var(--cell) var(--cell)",
        gridAutoRows: "var(--cell)",
        gap: "var(--s-2)",
        justifyContent: "center",
      }}>
        {Object.entries(DOLL_LAYOUT).map(([slot, { row, col }]) => (
          <div key={slot} style={{ gridRow: row, gridColumn: col }}>
            <EquipSlot
              item={(eq as unknown as Record<string, ItemStack | null | undefined>)[slot] ?? null}
              slot={slot}
              onAction={onAction}
            />
          </div>
        ))}
      </div>
    </Pane>
  );
}
