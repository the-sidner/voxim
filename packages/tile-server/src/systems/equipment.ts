import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { ContentStore, EquipSlot } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position } from "../components/game.ts";
import { Inventory, ItemData } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { Equipment } from "../components/equipment.ts";
import type { EquipmentData } from "../components/equipment.ts";
import { LightEmitter } from "../components/light.ts";
import { QualityStamped } from "../components/instance.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("EquipmentSystem");

/**
 * EquipmentSystem — processes all inventory and equipment slot commands.
 *
 * Commands handled:
 *   Equip        Move item from a specific inventory slot into its equipment slot.
 *                Stack slots spawn a new item entity; unique slots reuse the existing one.
 *   Unequip      Move item entity from equipment slot back to inventory as a unique slot.
 *   MoveItem     Swap two inventory slots.
 *   DropItem     Remove an item from inventory and place it in the world.
 *   UseItem      Consume an item from a specific inventory slot (delegate to consumable logic).
 *
 * Equipment slots store EntityIds; stats are read via world.get(entityId, ItemData).
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

    const slot = inv.slots[fromInventorySlot];
    const prefabId = slotPrefabId(slot, world);
    if (!prefabId) {
      log.debug("equip rejected: entity=%s slot=%d has no prefabId", entityId, fromInventorySlot);
      return;
    }

    const prefab = this.content.getPrefab(prefabId);
    const equippable = prefab?.components["equippable"] as { slot: string } | undefined;
    if (!equippable) {
      log.debug("equip rejected: entity=%s item=%s has no equippable component", entityId, prefabId);
      return;
    }

    const equipSlot = equippable.slot as EquipSlot;
    if (equipment[equipSlot] !== null) {
      log.debug("equip rejected: entity=%s slot=%s already occupied", entityId, equipSlot);
      return;
    }

    // Get or create the item entity
    let itemEntityId: EntityId;
    let newSlots: InventorySlot[];

    if (slot.kind === "stack") {
      itemEntityId = spawnItemEntity(world, prefabId, 1);
      newSlots = slot.quantity <= 1
        ? inv.slots.filter((_, i) => i !== fromInventorySlot)
        : inv.slots.map((s, i) => i === fromInventorySlot
            ? { kind: "stack" as const, prefabId: slot.prefabId, quantity: slot.quantity - 1 }
            : s);
    } else {
      itemEntityId = slot.entityId as EntityId;
      newSlots = inv.slots.filter((_, i) => i !== fromInventorySlot);
    }

    world.set(entityId, Equipment, { ...equipment, [equipSlot]: itemEntityId });
    world.set(entityId, Inventory, { ...inv, slots: newSlots });

    const quality = world.get(itemEntityId, QualityStamped)?.quality ?? 1;
    const stats = this.content.deriveItemStats(prefabId, [], quality);
    if (stats.lightRadius !== undefined) {
      world.set(entityId, LightEmitter, {
        color:     stats.lightColor     ?? 0xffaa44,
        intensity: stats.lightIntensity ?? 1.0,
        radius:    stats.lightRadius,
        flicker:   stats.lightFlicker   ?? 0.15,
      });
    }
    log.info("equipped: entity=%s item=%s slot=%s", entityId, prefabId, equipSlot);
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

    const itemEntityId = equipment[slot];
    if (itemEntityId === null) {
      log.debug("unequip rejected: entity=%s slot=%s already empty", entityId, slot);
      return;
    }

    const prefabId = world.get(itemEntityId as EntityId, ItemData)?.prefabId ?? "?";
    const uniqueSlot: InventorySlot = { kind: "unique", entityId: itemEntityId };
    const totalItems = inv.slots.reduce((s, sl) => s + (sl.kind === "stack" ? sl.quantity : 1), 0);

    const newEquipment = { ...equipment, [slot]: null };

    if (totalItems + 1 > inv.capacity) {
      // Drop the item entity into the world instead
      const pos = world.get(entityId, Position);
      if (pos) {
        world.set(itemEntityId as EntityId, Position, {
          x: pos.x + (Math.random() - 0.5),
          y: pos.y + (Math.random() - 0.5),
          z: pos.z,
        });
      }
      world.set(entityId, Equipment, newEquipment);
      this._updateLightEmitter(world, entityId, newEquipment);
      log.info("unequipped: entity=%s item=%s slot=%s (dropped — inventory full)", entityId, prefabId, slot);
      return;
    }

    world.set(entityId, Equipment, newEquipment);
    world.set(entityId, Inventory, { ...inv, slots: [...inv.slots, uniqueSlot] });
    this._updateLightEmitter(world, entityId, newEquipment);
    log.info("unequipped: entity=%s item=%s slot=%s (returned to inventory)", entityId, prefabId, slot);
  }

  /**
   * After any equipment change, recalculate the LightEmitter from the best
   * light-emitting item currently equipped.
   */
  private _updateLightEmitter(world: World, entityId: EntityId, newEquipment: EquipmentData): void {
    const SLOTS: (keyof EquipmentData)[] = ["weapon", "offHand", "head", "chest", "legs", "feet", "back"];
    let bestRadius = 0;
    let bestColor = 0xffaa44;
    let bestIntensity = 1.0;
    let bestFlicker = 0.15;

    for (const s of SLOTS) {
      const slotId = newEquipment[s];
      if (!slotId) continue;
      const prefabId = world.get(slotId as EntityId, ItemData)?.prefabId;
      if (!prefabId) continue;
      const quality = world.get(slotId as EntityId, QualityStamped)?.quality ?? 1;
      const stats = this.content.deriveItemStats(prefabId, [], quality);
      if (stats.lightRadius !== undefined && stats.lightRadius > bestRadius) {
        bestRadius    = stats.lightRadius;
        bestColor     = stats.lightColor     ?? 0xffaa44;
        bestIntensity = stats.lightIntensity ?? 1.0;
        bestFlicker   = stats.lightFlicker   ?? 0.15;
      }
    }

    if (bestRadius > 0) {
      world.set(entityId, LightEmitter, { color: bestColor, intensity: bestIntensity, radius: bestRadius, flicker: bestFlicker });
    } else if (world.has(entityId, LightEmitter)) {
      // Zero-intensity write — client tears down PointLight when intensity <= 0 (T-097).
      world.set(entityId, LightEmitter, { color: 0, intensity: 0, radius: 0, flicker: 0 });
    }
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
    const label = from.kind === "stack" ? from.prefabId : from.entityId;
    log.debug("move_item: entity=%s from=%d to=%d item=%s", entityId, fromSlot, toSlot, label);
  }

  private _handleDropItem(
    world: World,
    entityId: EntityId,
    fromSlot: number,
    inv: { slots: InventorySlot[]; capacity: number },
  ): void {
    if (fromSlot < 0 || fromSlot >= inv.slots.length) return;

    const slot = inv.slots[fromSlot];
    const pos = world.get(entityId, Position);
    const dropX = (pos?.x ?? 0) + (Math.random() - 0.5);
    const dropY = (pos?.y ?? 0) + (Math.random() - 0.5);
    const dropZ = pos?.z ?? 4.0;

    if (slot.kind === "stack") {
      const id = newEntityId();
      world.create(id);
      world.write(id, Position, { x: dropX, y: dropY, z: dropZ });
      world.write(id, ItemData, { prefabId: slot.prefabId, quantity: slot.quantity });
      log.info("drop_item: entity=%s item=%s qty=%d", entityId, slot.prefabId, slot.quantity);
    } else {
      // Unique entity — give it a position to place it in the world
      world.set(slot.entityId as EntityId, Position, { x: dropX, y: dropY, z: dropZ });
      log.info("drop_item: entity=%s unique=%s", entityId, slot.entityId);
    }

    world.set(entityId, Inventory, { ...inv, slots: inv.slots.filter((_, i) => i !== fromSlot) });
  }

  private _handleUseItem(
    world: World,
    entityId: EntityId,
    fromSlot: number,
    inv: { slots: InventorySlot[]; capacity: number },
  ): void {
    if (fromSlot < 0 || fromSlot >= inv.slots.length) return;

    const slot = inv.slots[fromSlot];
    const prefabId = slotPrefabId(slot, world);
    if (!prefabId) return;

    const prefab = this.content.getPrefab(prefabId);
    if (!prefab?.components["edible"]) {
      log.debug("use_item rejected: entity=%s item=%s has no edible component", entityId, prefabId);
      return;
    }

    let newSlots: InventorySlot[];
    if (slot.kind === "stack") {
      newSlots = slot.quantity <= 1
        ? inv.slots.filter((_, i) => i !== fromSlot)
        : inv.slots.map((s, i) => i === fromSlot
            ? { kind: "stack" as const, prefabId: slot.prefabId, quantity: slot.quantity - 1 }
            : s);
    } else {
      world.destroy(slot.entityId as EntityId);
      newSlots = inv.slots.filter((_, i) => i !== fromSlot);
    }
    world.set(entityId, Inventory, { ...inv, slots: newSlots });
    log.info("use_item: entity=%s item=%s slot=%d", entityId, prefabId, fromSlot);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve the prefabId from any inventory slot variant. */
export function slotPrefabId(slot: InventorySlot, world: World): string | null {
  if (slot.kind === "stack") return slot.prefabId;
  return world.get(slot.entityId as EntityId, ItemData)?.prefabId ?? null;
}

/** Resolve the prefabId for an equipment slot EntityId. */
export function equipPrefabId(slotId: string, world: World): string | null {
  return world.get(slotId as EntityId, ItemData)?.prefabId ?? null;
}

/** Create an item entity with no Position (lives in an equipment slot, not the world). */
export function spawnItemEntity(world: World, prefabId: string, quantity: number): EntityId {
  const id = newEntityId();
  world.create(id);
  world.write(id, ItemData, { prefabId, quantity });
  return id;
}

/** Map EquipSlotIndex numeric value → EquipmentData key. */
function indexToSlot(index: number): EquipSlot | null {
  const SLOTS: EquipSlot[] = ["weapon", "offHand", "head", "chest", "legs", "feet", "back"];
  return SLOTS[index] ?? null;
}
