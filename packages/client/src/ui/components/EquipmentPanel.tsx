import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";
import { usePanel } from "../use_panel.ts";
import type { UIAction } from "../ui_actions.ts";
import type { ItemStack } from "../ui_store.ts";

const equipment = computed(() => uiState.value.equipment);

function EquipSlot({ label, item, slot, onAction }: {
  label: string;
  item: ItemStack | null;
  slot: string;
  onAction: (a: UIAction) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--gap-xs)" }}>
      <span style={{ fontSize: "var(--text-xs)", color: "var(--col-text-dim)" }}>{label}</span>
      <div
        class={`slot interactive ${item ? "" : "slot--empty"}`}
        title={item?.displayName ?? label}
        onClick={() => item && onAction({ type: "unequip", slot })}
      >
        {/* TODO: render item icon from modelTemplateId */}
        {item && (
          <span style={{ fontSize: "var(--text-xs)" }}>
            {item.displayName.slice(0, 4)}
          </span>
        )}
      </div>
    </div>
  );
}

export function EquipmentPanel({ onAction }: { onAction: (a: UIAction) => void }) {
  const eq = equipment.value;
  const { panelProps, titleProps } = usePanel({ defaultX: 20, defaultY: 80 });

  return (
    <div class="panel interactive" {...panelProps} style={{ ...panelProps.style, width: "180px" }}>
      <div class="panel__title" {...titleProps}>Equipment</div>
      {/* TODO: character silhouette with slot positions */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "var(--gap-sm)" }}>
        <EquipSlot label="Head"    item={eq?.head    ?? null} slot="head"    onAction={onAction} />
        <EquipSlot label="Chest"   item={eq?.chest   ?? null} slot="chest"   onAction={onAction} />
        <EquipSlot label="Legs"    item={eq?.legs    ?? null} slot="legs"    onAction={onAction} />
        <EquipSlot label="Feet"    item={eq?.feet    ?? null} slot="feet"    onAction={onAction} />
        <EquipSlot label="Weapon"  item={eq?.weapon  ?? null} slot="weapon"  onAction={onAction} />
        <EquipSlot label="Off"     item={eq?.offHand ?? null} slot="offHand" onAction={onAction} />
        <EquipSlot label="Back"    item={eq?.back    ?? null} slot="back"    onAction={onAction} />
      </div>
    </div>
  );
}
