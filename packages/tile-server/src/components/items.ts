import type { Serialiser } from "@voxim/engine";
import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { itemDataCodec, inventoryCodec, craftingQueueCodec, buildCodec, WireWriter, WireReader } from "@voxim/codecs";
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

// ---- TomeData ----
// Server-only component on unique tome item entities (kind: "unique" slots).
// Carries the lore fragment encoded in this tome so DynastySystem can read it.

export interface TomeDataData {
  fragmentId: string;
}

const tomeDataCodec: Serialiser<TomeDataData> = {
  encode(v: TomeDataData): Uint8Array {
    const w = new WireWriter(); w.writeStr(v.fragmentId); return w.toBytes();
  },
  decode(bytes: Uint8Array): TomeDataData {
    return { fragmentId: new WireReader(bytes).readStr() };
  },
};

export const TomeData = defineComponent({
  name: "tomeData" as const,
  networked: false as const,
  codec: tomeDataCodec,
  default: (): TomeDataData => ({ fragmentId: "" }),
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
