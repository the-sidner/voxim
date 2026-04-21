import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { itemDataCodec, inventoryCodec, craftingQueueCodec, buildCodec } from "@voxim/codecs";
import type { ItemDataData, InventorySlot, InventoryData } from "@voxim/codecs";

// ---- ItemData ----
// Marks a world entity as a physical item (drop or equipment slot entity).
// prefabId identifies the Prefab definition; quantity for stackable drops.

export type { ItemDataData };

export const ItemData = defineComponent({
  name: "itemData" as const,
  wireId: ComponentType.itemData,
  codec: itemDataCodec,
  default: (): ItemDataData => ({ prefabId: "unknown", quantity: 1 }),
});

// ---- Inventory ----
// Items held by a player or NPC — not in the world, in their possession.
// Slots are a discriminated union: stack (prefabId + qty) or unique (entityId).

export type { InventorySlot, InventoryData };

export const Inventory = defineComponent({
  name: "inventory" as const,
  wireId: ComponentType.inventory,
  codec: inventoryCodec,
  default: (): InventoryData => ({ slots: [], capacity: 20 }),
});

// ---- CraftingQueue ----
// Tracks active and queued crafting work for an entity.

export interface CraftingQueueData {
  /** Recipe currently being crafted, or null if idle. */
  activeRecipeId: string | null;
  /** Ticks remaining until the active recipe completes. */
  progressTicks: number;
  /** IDs of recipes queued after the current one. */
  queued: string[];
}

export const CraftingQueue = defineComponent({
  name: "craftingQueue" as const,
  wireId: ComponentType.craftingQueue,
  codec: craftingQueueCodec,
  default: (): CraftingQueueData => ({
    activeRecipeId: null,
    progressTicks: 0,
    queued: [],
  }),
});

// ---- InteractCooldown ----
// Prevents re-triggering interact every tick while the button is held.

export interface InteractCooldownData {
  remaining: number;
}

export const InteractCooldown = defineComponent({
  name: "interactCooldown" as const,
  networked: false,
  codec: buildCodec<InteractCooldownData>({ remaining: { type: "i32" } }),
  default: (): InteractCooldownData => ({ remaining: 0 }),
});
