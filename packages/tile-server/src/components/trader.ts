import { defineComponent } from "@voxim/engine";
import { ComponentType, networkedCodec } from "@voxim/protocol";

/**
 * One entry in a trader's catalogue.
 *   buyPrice   — coins the player pays to buy 1 unit from the trader
 *   sellPrice  — coins the trader pays for 1 unit sold by the player
 *   stock      — units available to buy; -1 = unlimited
 */
export interface TraderListing {
  itemType: string;
  buyPrice: number;
  sellPrice: number;
  stock: number;
}

export interface TraderInventoryData {
  listings: TraderListing[];
}

/**
 * Marks an NPC as a trader.  The NPC must also have Position, NpcTag.
 * TraderSystem scans for player entities near traders each tick.
 */
export const TraderInventory = defineComponent({
  name: "traderInventory" as const,
  wireId: ComponentType.traderInventory,
  codec: networkedCodec<TraderInventoryData>(ComponentType.traderInventory),
  default: (): TraderInventoryData => ({ listings: [] }),
});
