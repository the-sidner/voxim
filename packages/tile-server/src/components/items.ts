import { defineComponent } from "@voxim/engine";
import { ComponentType, networkedCodec } from "@voxim/protocol";
import type { ItemDataData, InventorySlot, InventoryData } from "@voxim/codecs";

// ---- ItemData ----
// Marks a world entity as a physical item (drop or equipment slot entity).
// prefabId identifies the Prefab definition; quantity for stackable drops.

export type { ItemDataData };

export const ItemData = defineComponent({
  name: "itemData" as const,
  wireId: ComponentType.itemData,
  codec: networkedCodec<ItemDataData>(ComponentType.itemData),
  default: (): ItemDataData => ({ prefabId: "unknown", quantity: 1 }),
});

// ---- Inventory ----
// Items held by a player or NPC — not in the world, in their possession.
// Slots are a discriminated union: stack (prefabId + qty) or unique (entityId).

export type { InventorySlot, InventoryData };

export const Inventory = defineComponent({
  name: "inventory" as const,
  wireId: ComponentType.inventory,
  codec: networkedCodec<InventoryData>(ComponentType.inventory),
  default: (): InventoryData => ({ slots: [], capacity: 20 }),
});

