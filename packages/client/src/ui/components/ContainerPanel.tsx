/// <reference lib="dom" />
/**
 * ContainerPanel — deposit/withdraw view for the family chest the player just
 * opened: the library (tomes) or treasury (gear), T-077/T-078.
 *
 * Open/close is driven by uiState.container (set by game.ts on click, cleared by
 * closePanel("container")). game.ts mirrors the chest's networked `container`
 * slots here on every state message that touches the open chest, so the panel
 * stays purely reactive.
 *
 * Each slot is BOTH a drop target (drag an inventory item in → deposit) and a
 * drag source (drag an occupied slot out → withdraw to inventory) — the same
 * pattern the workstation buffer uses. Only unique-entity items bank; the server
 * gates dynasty/kind/capacity/reach, so an invalid drop simply no-ops.
 */
import { computed } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { uiState, closePanel, type ItemStack, type ContainerSlotView } from "../ui_store.ts";
import { dragSystem } from "../drag_system.ts";
import type { UIAction } from "../ui_actions.ts";
import { Pane, Slot, Section } from "./primitives.tsx";
import { humanizeItemType } from "../item_names.ts";

const container = computed(() => uiState.value.container);

function ChestSlotCell({ slot, index, containerId, onAction }: {
  slot: ContainerSlotView | null;
  index: number;
  containerId: string;
  onAction: (a: UIAction) => void;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState(false);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const zoneId = `container:${index}`;
    dragSystem.registerZone(el, zoneId, {
      accept: ["inventory"],
      onDrop: (drag) => {
        onAction({ type: "deposit_container", containerId, inventorySlot: drag.sourceIndex });
        dragSystem.endDrag();
      },
      onEnter: () => setDrop(true),
      onLeave: () => setDrop(false),
    });
    return () => { dragSystem.unregisterZone(zoneId); setDrop(false); };
  }, [index, containerId]);

  const handleMouseDown = (e: MouseEvent) => {
    if (!slot) return;
    const stack: ItemStack = {
      itemType: slot.prefabId,
      quantity: 1,
      displayName: humanizeItemType(slot.prefabId),
      modelTemplateId: null,
      entityId: slot.entityId,
    };
    // Drag out and drop anywhere outside a zone → withdraw into the player's
    // inventory (the server routes it there), mirroring workstation `take`.
    dragSystem.startDrag(stack, "container", index, e.currentTarget as HTMLElement, () => {
      onAction({ type: "withdraw_container", containerId, slotIndex: index });
    });
  };

  const highlight = drop && uiState.value.drag?.sourceKind === "inventory";
  const label = slot ? humanizeItemType(slot.prefabId) : "";

  return (
    <Slot elRef={elRef} empty={!slot} dragover={highlight} title={label} onMouseDown={handleMouseDown}>
      {slot && <span class="slot-glyph">{label.slice(0, 1).toUpperCase()}</span>}
    </Slot>
  );
}

export function ContainerPanel({ onAction }: { onAction: (a: UIAction) => void }) {
  const c = container.value;
  if (!c) return null;

  const slots: (ContainerSlotView | null)[] = [...c.slots];
  while (slots.length < c.capacity) slots.push(null);
  const cols = Math.min(6, c.capacity);
  const title = c.kind === "tome" ? "Library" : "Treasury";

  return (
    <Pane
      title={title}
      defaultX={460} defaultY={80}
      onClose={() => closePanel("container")}
      style={{ width: "320px" }}
      foot={<span class="num">{c.slots.length} / {c.capacity}</span>}
    >
      <Section title={c.kind === "tome" ? "Tomes" : "Gear"}>
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
            <ChestSlotCell key={i} slot={slot} index={i} containerId={c.entityId} onAction={onAction} />
          ))}
        </div>
      </Section>
    </Pane>
  );
}
