import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { itemDataCodec, inventoryCodec, craftingQueueCodec, buildCodec } from "@voxim/codecs";
import type { ItemPart } from "@voxim/content";

// ---- ItemData ----
// Marks an entity as a physical item in the world.
// Item entities have Position + ItemData; the client renders them as small objects.

export interface ItemDataData {
  itemType: string; // e.g. "wood", "stone", "wooden_sword"
  quantity: number;
  /** Material parts for composed items. Undefined for simple stackable resources. */
  parts?: ItemPart[];
  /** Durability 0–100. Undefined for items that don't wear. */
  condition?: number;
}

export const ItemData = defineComponent({
  name: "itemData" as const,
  wireId: ComponentType.itemData,
  codec: itemDataCodec,
  default: (): ItemDataData => ({ itemType: "unknown", quantity: 1 }),
});

// ---- Inventory ----
// Items held by a player or NPC — not in the world, in their possession.

export interface InventorySlot {
  itemType: string;
  quantity: number;
  /** Material parts for composed items. Undefined for simple stackable resources. */
  parts?: ItemPart[];
  /** Durability 0–100. Undefined for items that don't wear. */
  condition?: number;
  /**
   * For tome items only — the ID of the LoreFragment encoded in this tome.
   * Undefined for all other item types.
   */
  fragmentId?: string;
}

export interface InventoryData {
  slots: InventorySlot[];
  /** Max total item count. */
  capacity: number;
}

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
  wireId: ComponentType.interactCooldown,
  codec: buildCodec<InteractCooldownData>({ remaining: { type: "i32" } }),
  default: (): InteractCooldownData => ({ remaining: 0 }),
});
