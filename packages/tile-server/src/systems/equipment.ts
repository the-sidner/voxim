import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { ContentStore, EquipSlot } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position } from "../components/game.ts";
import { Inventory } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { ItemData } from "../components/items.ts";
import { Equipment } from "../components/equipment.ts";
import type { EquipmentData } from "../components/equipment.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("EquipmentSystem");

/**
 * EquipmentSystem — processes all inventory and equipment slot commands.
 *
 * Commands handled:
 *   Equip        Move item from a specific inventory slot into its equipment slot
 *                (the target slot is determined by the item template's equipSlot field).
 *   Unequip      Move item from a specific equipment slot back to inventory.
 *   MoveItem     Swap two inventory slots.
 *   DropItem     Remove an item from inventory and spawn it as a world entity.
 *   UseItem      Consume an item from a specific inventory slot (delegate to consumable logic).
 *
 * Commands arrive via TickContext.pendingCommands, cached in prepare() and
 * processed in run().  No InputState action bits are used.
 */
export class EquipmentSystem implements System {
  private _commands: ReadonlyMap<string, CommandPayload[]> = new Map();

  constructor(private readonly content: ContentStore) {}

  prepare(_serverTick: number, ctx: TickContext): void {
    this._commands = ctx.pendingCommands;
  }

  run(world: World, _events: EventEmitter, _dt: number): void {
    for (const [entityId, commands] of this._commands) {
      if (!world.isAlive(entityId)) continue;
      const equipment = world.get(entityId, Equipment);
      const inv = world.get(entityId, Inventory);
      if (!equipment || !inv) continue;

      for (const cmd of commands) {
        switch (cmd.cmd) {
          case CommandType.Equip:
            this._handleEquip(world, entityId, cmd.fromInventorySlot, equipment, inv);
            break;
          case CommandType.Unequip:
            this._handleUnequip(world, entityId, cmd.equipSlot, equipment, inv);
            break;
          case CommandType.MoveItem:
            this._handleMoveItem(world, entityId, cmd.fromSlot, cmd.toSlot, inv);
            break;
          case CommandType.DropItem:
            this._handleDropItem(world, entityId, cmd.fromSlot, inv);
            break;
          case CommandType.UseItem:
            this._handleUseItem(world, entityId, cmd.fromSlot, inv);
            break;
        }
        // Re-read after each command so the next one sees the updated state.
        // world.get returns the latest deferred value within the same tick.
      }
    }
  }

  // ── Command handlers ────────────────────────────────────────────────────

  private _handleEquip(
    world: World,
    entityId: EntityId,
    fromInventorySlot: number,
    equipment: EquipmentData,
    inv: { slots: InventorySlot[]; capacity: number },
  ): void {
    if (fromInventorySlot < 0 || fromInventorySlot >= inv.slots.length) return;

    const item = inv.slots[fromInventorySlot];
    const template = this.content.getItemTemplate(item.itemType);
    if (!template?.equipSlot) {
      log.debug("equip rejected: entity=%s item=%s has no equipSlot", entityId, item.itemType);
      return;
    }

    const slot = template.equipSlot as EquipSlot;
    if (equipment[slot] !== null) {
      log.debug("equip rejected: entity=%s slot=%s already occupied", entityId, slot);
      return;
    }

    const newSlots = inv.slots.filter((_, i) => i !== fromInventorySlot);
    world.set(entityId, Equipment, { ...equipment, [slot]: item });
    world.set(entityId, Inventory, { ...inv, slots: newSlots });
    log.info("equipped: entity=%s item=%s slot=%s", entityId, item.itemType, slot);
  }

  private _handleUnequip(
    world: World,
    entityId: EntityId,
    equipSlotIndex: number,
    equipment: EquipmentData,
    inv: { slots: InventorySlot[]; capacity: number },
  ): void {
    const slot = indexToSlot(equipSlotIndex);
    if (!slot) {
      log.debug("unequip rejected: entity=%s unknown slot index %d", entityId, equipSlotIndex);
      return;
    }

    const item = equipment[slot];
    if (item === null) {
      log.debug("unequip rejected: entity=%s slot=%s already empty", entityId, slot);
      return;
    }

    const totalItems = inv.slots.reduce((s, sl) => s + sl.quantity, 0);
    if (totalItems + item.quantity > inv.capacity) {
      dropItem(world, entityId, item);
      world.set(entityId, Equipment, { ...equipment, [slot]: null });
      log.info("unequipped: entity=%s item=%s slot=%s (dropped — inventory full)", entityId, item.itemType, slot);
      return;
    }

    world.set(entityId, Equipment, { ...equipment, [slot]: null });
    world.set(entityId, Inventory, { ...inv, slots: [...inv.slots, item] });
    log.info("unequipped: entity=%s item=%s slot=%s (returned to inventory)", entityId, item.itemType, slot);
  }

  private _handleMoveItem(
    world: World,
    entityId: EntityId,
    fromSlot: number,
    toSlot: number,
    inv: { slots: InventorySlot[]; capacity: number },
  ): void {
    if (
      fromSlot < 0 || fromSlot >= inv.slots.length ||
      toSlot < 0 || toSlot >= inv.capacity
    ) return;

    const newSlots = [...inv.slots];
    // toSlot may be beyond current length (moving into an empty slot).
    // Grow the array with sparse assignment, then filter undefineds.
    const from = newSlots[fromSlot];
    const to   = newSlots[toSlot] ?? null;
    if (to !== null) {
      newSlots[fromSlot] = to;
      newSlots[toSlot]   = from;
    } else {
      newSlots.splice(fromSlot, 1);
      newSlots.splice(toSlot > fromSlot ? toSlot - 1 : toSlot, 0, from);
    }
    world.set(entityId, Inventory, { ...inv, slots: newSlots });
    log.debug("move_item: entity=%s from=%d to=%d item=%s", entityId, fromSlot, toSlot, from.itemType);
  }

  private _handleDropItem(
    world: World,
    entityId: EntityId,
    fromSlot: number,
    inv: { slots: InventorySlot[]; capacity: number },
  ): void {
    if (fromSlot < 0 || fromSlot >= inv.slots.length) return;

    const item = inv.slots[fromSlot];
    const newSlots = inv.slots.filter((_, i) => i !== fromSlot);
    world.set(entityId, Inventory, { ...inv, slots: newSlots });
    dropItem(world, entityId, item);
    log.info("drop_item: entity=%s item=%s qty=%d slot=%d", entityId, item.itemType, item.quantity, fromSlot);
  }

  private _handleUseItem(
    world: World,
    entityId: EntityId,
    fromSlot: number,
    inv: { slots: InventorySlot[]; capacity: number },
  ): void {
    if (fromSlot < 0 || fromSlot >= inv.slots.length) return;

    const item = inv.slots[fromSlot];
    const template = this.content.getItemTemplate(item.itemType);
    if (template?.category !== "consumable") {
      log.debug("use_item rejected: entity=%s item=%s is not consumable", entityId, item.itemType);
      return;
    }

    const newSlots = [...inv.slots];
    if (item.quantity <= 1) {
      newSlots.splice(fromSlot, 1);
    } else {
      newSlots[fromSlot] = { ...item, quantity: item.quantity - 1 };
    }
    world.set(entityId, Inventory, { ...inv, slots: newSlots });
    log.info("use_item: entity=%s item=%s slot=%d", entityId, item.itemType, fromSlot);
    // Actual stat effects (hunger, health, stamina) are applied by ConsumptionSystem
    // when ACTION_CONSUME fires, or can be emitted here as an event when needed.
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Map EquipSlotIndex numeric value → EquipmentData key. */
function indexToSlot(index: number): EquipSlot | null {
  const SLOTS: EquipSlot[] = ["weapon", "offHand", "head", "chest", "legs", "feet", "back"];
  return SLOTS[index] ?? null;
}

function dropItem(world: World, entityId: EntityId, slot: InventorySlot): void {
  const pos = world.get(entityId, Position);
  if (!pos) return;
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, {
    x: pos.x + (Math.random() - 0.5),
    y: pos.y + (Math.random() - 0.5),
    z: pos.z,
  });
  world.write(id, ItemData, {
    itemType: slot.itemType,
    quantity: slot.quantity,
    ...(slot.parts    ? { parts: slot.parts }         : {}),
    ...(slot.condition !== undefined ? { condition: slot.condition } : {}),
  });
}
