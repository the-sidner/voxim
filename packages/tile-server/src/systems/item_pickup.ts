/**
 * ItemPickupSystem — auto-collects nearby ItemData entities into player Inventory.
 *
 * Skips entities with NpcTag — NPCs handle food/water via NpcAiSystem's direct
 * consumption path (seekFood/seekWater jobs), which does not go through Inventory.
 * Mixing the two paths causes double-destroy of the same world entity and leaves
 * unconsumed food in NPC inventories.
 *
 * Uses SpatialGrid (via prepare/TickContext) to restrict candidate drops to cells
 * within pickupRadius — O(collectors × entities_in_radius_cells) not O(N×M).
 */
import type { World, EntityId } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position } from "../components/game.ts";
import { Inventory, ItemData } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { NpcTag } from "../components/npcs.ts";
import type { SpatialGrid } from "../spatial_grid.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ItemPickupSystem");

export class ItemPickupSystem implements System {
  private spatial: SpatialGrid | null = null;
  private radiusSq = 0;
  private pickupRadius = 0;

  constructor(private readonly content: ContentStore) {
    const r = content.getGameConfig().items.pickupRadius;
    this.pickupRadius = r;
    this.radiusSq = r * r;
  }

  prepare(_tick: number, ctx: TickContext): void {
    this.spatial = ctx.spatial;
  }

  run(world: World, _events: EventEmitter, _dt: number): void {
    if (!this.spatial) return;

    const claimed = new Set<EntityId>();

    for (const { entityId: collectorId, position, inventory } of world.query(Position, Inventory)) {
      if (world.has(collectorId, NpcTag)) continue;

      const candidates = this.spatial.nearby(position.x, position.y, this.pickupRadius);
      if (candidates.length === 0) continue;

      let slots = inventory.slots;
      let changed = false;

      for (const candidateId of candidates) {
        if (claimed.has(candidateId)) continue;

        const itemData = world.get(candidateId, ItemData);
        if (!itemData) continue;

        const itemPos = world.get(candidateId, Position);
        if (!itemPos) continue;
        const dx = itemPos.x - position.x;
        const dy = itemPos.y - position.y;
        if (dx * dx + dy * dy > this.radiusSq) continue;

        const newSlots = addToInventory(slots, itemData.prefabId, itemData.quantity, inventory.capacity);
        if (newSlots === null) continue;

        slots = newSlots;
        changed = true;
        claimed.add(candidateId);
        log.info("pickup: collector=%s item=%sx%d", collectorId, itemData.prefabId, itemData.quantity);
      }

      if (changed) {
        world.set(collectorId, Inventory, { ...inventory, slots });
      }
    }

    for (const id of claimed) {
      world.destroy(id);
    }
  }
}

function addToInventory(
  slots: InventorySlot[],
  prefabId: string,
  quantity: number,
  capacity: number,
): InventorySlot[] | null {
  const total = slots.reduce((s, sl) => s + (sl.kind === "stack" ? sl.quantity : 1), 0);
  if (total + quantity > capacity) return null;
  const existing = slots.find((s): s is Extract<InventorySlot, { kind: "stack" }> =>
    s.kind === "stack" && s.prefabId === prefabId
  );
  if (existing) {
    return slots.map((s) => s === existing ? { ...s, quantity: s.quantity + quantity } : s);
  }
  return [...slots, { kind: "stack", prefabId, quantity }];
}
