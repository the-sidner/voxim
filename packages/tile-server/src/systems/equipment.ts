import type { World, EntityId } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { spawnGroundStack, resolveAttachParent } from "../spawner.ts";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { ContentService, EquipSlot } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position } from "../components/game.ts";
import { Inventory, ItemData } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { Equipment } from "../components/equipment.ts";
import type { EquipmentData } from "../components/equipment.ts";
import { LightEmitter } from "../components/light.ts";
import { PendingItemUse } from "../components/action.ts";
import { QualityStamped } from "../components/instance.ts";
import { findByIdentity, removeAt, slotIdentity } from "../inventory_ops.ts";
import type { SlotIdentity } from "../inventory_ops.ts";
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
 *   UseItem      Stimulus only — drops a one-shot `PendingItemUse`; the
 *                `use_item` action (ActionDispatcher) does the actual work
 *                via the shared effect registry (T-240). Not handled here.
 *
 * Equipment slots store EntityIds; stats are read via world.get(entityId, ItemData).
 */
export class EquipmentSystem implements System {
  private _commands: ReadonlyMap<string, CommandPayload[]> = new Map();

  constructor(private readonly content: ContentService) {}

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
            // T-240: "use" is the `use_item` action, not a command handler.
            // Drop a one-shot stimulus the PrimaryIntentResolver turns into
            // the action next tick; effects resolve through the shared
            // registry. Ph1 has no per-slot payload (first usable item).
            world.set(entityId, PendingItemUse, { _: 0 });
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

    const prefab = this.content.prefabs.get(prefabId);
    const equippable = prefab?.components["equippable"] as { slots: EquipSlot[] } | undefined;
    if (!equippable || equippable.slots.length === 0) {
      log.debug("equip rejected: entity=%s item=%s has no equippable component", entityId, prefabId);
      return;
    }

    // Land in the first declared slot that's free (T-187), so a weapon
    // declaring ["weapon","offHand"] fills the off-hand when the main hand is
    // taken — dual-wield from the inventory. All candidates occupied → reject.
    const equipSlot = equippable.slots.find((s) => equipment[s] === null);
    if (!equipSlot) {
      log.debug("equip rejected: entity=%s item=%s — all candidate slots [%s] occupied",
        entityId, prefabId, equippable.slots.join(","));
      return;
    }

    // Get or create the item entity. T-344 residual: the stack-spawn below
    // is unconditional/irreversible — if the Equipment claim declines (a
    // same-tick race already filled equipSlot), this entity is orphaned,
    // never referenced by Equipment or Inventory. Narrow (needs another
    // same-tick command landing on this entity's SAME candidate equip
    // slot) and acceptable — nothing the player already owned is lost.
    let itemEntityId: EntityId;
    if (slot.kind === "stack") {
      itemEntityId = spawnItemEntity(world, prefabId, 1);
    } else {
      itemEntityId = slot.entityId as EntityId;
    }
    const sourceIdentity: SlotIdentity = slotIdentity(slot);

    // T-344: COUPLED-DECLINE. Equipment claims equipSlot first — its own
    // recheck against commit-time state, declining if a same-tick op
    // already filled it (this system's per-entity command loop does not
    // break after one command, so two Equip/MoveItem/DropItem commands for
    // ONE player in ONE tick is a real, reachable path, not just a
    // cross-system one). Inventory's removal is dependent on the claim and
    // re-locates the source slot by identity rather than trusting
    // fromInventorySlot literally, since an earlier same-tick MoveItem/
    // DropItem in this SAME command batch could have shifted indices.
    // Sound because both mutates are pushed from this one synchronous
    // call — World.applyChangeset walks pendingOps in push order, so the
    // Equipment closure always runs before the Inventory one at commit
    // (see inventory_ops.ts's header comment for the load-bearing detail).
    let claimed = false;
    world.mutate(entityId, Equipment, (cur) => {
      if (cur[equipSlot] !== null) return cur;
      claimed = true;
      return { ...cur, [equipSlot]: { entityId: itemEntityId, prefabId } };
    });
    world.mutate(entityId, Inventory, (cur) => {
      if (!claimed) return cur;
      const idx = findByIdentity(cur.slots, sourceIdentity, fromInventorySlot);
      if (idx === -1) return cur; // source slot vanished by commit time — see residual above
      return { ...cur, slots: removeAt(cur.slots, idx) };
    });
    // T-220: scene-graph attach (setParent to the resolved bone, or the
    // holder root as a fallback). Deferred (world.reparent, not
    // world.setParent) -- itemEntityId may already be known to this
    // player's own session (a pre-existing unique inventory item is
    // already in their AoI, aoi.ts's own-item carve-out), and setParent's
    // immediate write never reaches the wire delta builder for an entity
    // a session already knows. Works identically whether itemEntityId is
    // the brand-new stack-spawn case or the pre-existing unique-slot case.
    //
    // T-344: this stays optimistic — world.reparent is an IMMEDIATE write
    // (bypasses the deferred changeset entirely, world.ts), so it
    // necessarily runs before the Equipment mutate's commit-time outcome
    // is knowable. Residual: in the rare same-tick collision where the
    // claim above declines, the item still gets reparented to the equip
    // bone (a cosmetic desync — self-corrects on this entity's next
    // successful equip/unequip) while gameplay logic, which reads
    // Equipment not Parent, still correctly treats it as un-equipped.
    world.reparent(itemEntityId, resolveAttachParent(world, entityId, equipSlot));

    const quality = world.get(itemEntityId, QualityStamped)?.quality ?? 1;
    const stats = this.content.deriveItemStats(prefabId, [], quality);
    if (stats.lightRadius !== undefined) {
      world.set(entityId, LightEmitter, {
        color:     stats.lightColor     ?? 0xffaa44,
        intensity: stats.lightIntensity ?? 1.0,
        radius:    stats.lightRadius,
        lightDefId: stats.lightDefId    ?? "torch",
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

    const equippedItem = equipment[slot];
    if (equippedItem === null) {
      log.debug("unequip rejected: entity=%s slot=%s already empty", entityId, slot);
      return;
    }

    const itemEntityId = equippedItem.entityId as EntityId;
    const prefabId = equippedItem.prefabId;
    const uniqueSlot: InventorySlot = { kind: "unique", entityId: itemEntityId };
    const totalItems = inv.slots.reduce((s, sl) => s + (sl.kind === "stack" ? sl.quantity : 1), 0);
    const newEquipment = { ...equipment, [slot]: null };

    // T-344: TARGETED-DECLINE — only clear the slot (and, below, grant the
    // item back) if it STILL holds the exact item captured above. Guards
    // against a duplicate/replayed Unequip for the same slot in the same
    // tick handing the item out twice, and against nulling out a DIFFERENT
    // item a same-tick Equip already claimed there (same push-order
    // reasoning as _handleEquip — see inventory_ops.ts).
    let cleared = false;
    world.mutate(entityId, Equipment, (cur) => {
      const cs = cur[slot];
      if (!cs || cs.entityId !== itemEntityId) return cur;
      cleared = true;
      return { ...cur, [slot]: null };
    });

    if (totalItems + 1 > inv.capacity) {
      // Drop the item entity into the world instead. T-344 residual: this
      // branch choice (drop vs. return) is itself decided from the stale
      // totalItems/capacity snapshot above — a same-tick capacity swing
      // either way can't be corrected mid-flight without a conditional-op
      // primitive the engine doesn't have. Bounded: worst case is a
      // redundant drop-to-world write on a duplicate/raced Unequip
      // (overwriting Position is idempotent), never a lost item.
      const pos = world.get(entityId, Position);
      if (pos) {
        world.set(itemEntityId as EntityId, Position, {
          x: pos.x + (Math.random() - 0.5),
          y: pos.y + (Math.random() - 0.5),
          z: pos.z,
        });
      }
      world.reparent(itemEntityId, null); // T-220: leaves the scene graph — it's a world object now
      this._updateLightEmitter(world, entityId, newEquipment);
      log.info("unequipped: entity=%s item=%s slot=%s (dropped — inventory full)", entityId, prefabId, slot);
      return;
    }

    world.reparent(itemEntityId, null); // T-220: back to inventory — no longer scene-graph attached
    world.mutate(entityId, Inventory, (cur) => {
      if (!cleared) return cur; // Equipment clear declined — don't also grant the item (see above)
      return { ...cur, slots: [...cur.slots, uniqueSlot] };
    });
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
    let bestLightDefId = "torch";

    for (const s of SLOTS) {
      const slot = newEquipment[s];
      if (!slot) continue;
      const prefabId = slot.prefabId;
      const quality = world.get(slot.entityId as EntityId, QualityStamped)?.quality ?? 1;
      const stats = this.content.deriveItemStats(prefabId, [], quality);
      if (stats.lightRadius !== undefined && stats.lightRadius > bestRadius) {
        bestRadius    = stats.lightRadius;
        bestColor     = stats.lightColor     ?? 0xffaa44;
        bestIntensity = stats.lightIntensity ?? 1.0;
        bestLightDefId = stats.lightDefId    ?? "torch";
      }
    }

    if (bestRadius > 0) {
      world.set(entityId, LightEmitter, { color: bestColor, intensity: bestIntensity, radius: bestRadius, lightDefId: bestLightDefId });
    } else if (world.has(entityId, LightEmitter)) {
      // No light-emitting item equipped — remove the component (T-269). The
      // removal reaches the client over the wire's removal channel (T-250) and
      // its LightManager tears down the PointLight on the absent component.
      // (Was a zero-intensity sentinel write before the removal channel existed
      // — the T-097 workaround.)
      world.remove(entityId, LightEmitter);
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

    // T-344: the whole swap/splice moves INSIDE the closure, recomputed
    // against commit-time `cur.slots` — this system's command loop does
    // not break after one command, so two MoveItem/Equip/DropItem commands
    // for ONE player in ONE tick is a real, reachable path. Wrapping the
    // stale pre-computed newSlots in world.mutate (instead of moving the
    // computation itself inside) would have kept the bug wearing a hat.
    world.mutate(entityId, Inventory, (cur) => {
      if (fromSlot >= cur.slots.length || toSlot >= cur.capacity) return cur;
      const newSlots = [...cur.slots];
      const from = newSlots[fromSlot];
      const to   = newSlots[toSlot] ?? null;
      if (to !== null) {
        newSlots[fromSlot] = to;
        newSlots[toSlot]   = from;
      } else {
        newSlots.splice(fromSlot, 1);
        newSlots.splice(toSlot > fromSlot ? toSlot - 1 : toSlot, 0, from);
      }
      return { ...cur, slots: newSlots };
    });
    const from = inv.slots[fromSlot];
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
    const identity = slotIdentity(slot);
    const pos = world.get(entityId, Position);
    const dropX = (pos?.x ?? 0) + (Math.random() - 0.5);
    const dropY = (pos?.y ?? 0) + (Math.random() - 0.5);
    const dropZ = pos?.z ?? 4.0;

    // T-344 residual: spawning the ground stack / repositioning the unique
    // entity is irreversible and computed from this queue-time read of
    // `slot`. The removal below re-locates by identity (handles an
    // ordinary same-tick reshuffle from another command correctly, full
    // scan included) and declines if it's genuinely gone by commit time —
    // narrowed to a duplication only when a SECOND command in the same
    // tick also targets this exact captured item (e.g. a replayed
    // DropItem), not the ordinary "two different writers" case T-344
    // targets, which this already handles.
    if (slot.kind === "stack") {
      spawnGroundStack(world, this.content, slot.prefabId, slot.quantity, { x: dropX, y: dropY, z: dropZ });
      log.info("drop_item: entity=%s item=%s qty=%d", entityId, slot.prefabId, slot.quantity);
    } else {
      // Unique entity — give it a position to place it in the world.
      // T-220: setParent(null) + Position write. A defensive no-op on every
      // currently-reachable path (an item must be unequipped — which
      // already reparents to null — before it can be dropped from
      // inventory; DropItem only ever reads inv.slots, never equipment
      // slots directly) but matches the plan's literal spec and guards a
      // future direct-drop-from-equipped-slot command.
      world.reparent(slot.entityId as EntityId, null);
      world.set(slot.entityId as EntityId, Position, { x: dropX, y: dropY, z: dropZ });
      log.info("drop_item: entity=%s unique=%s", entityId, slot.entityId);
    }

    world.mutate(entityId, Inventory, (cur) => {
      const idx = findByIdentity(cur.slots, identity, fromSlot);
      if (idx === -1) return cur;
      return { ...cur, slots: cur.slots.filter((_, i) => i !== idx) };
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve the prefabId from any inventory slot variant. */
export function slotPrefabId(slot: InventorySlot, world: World): string | null {
  if (slot.kind === "stack") return slot.prefabId;
  return world.get(slot.entityId as EntityId, ItemData)?.prefabId ?? null;
}

/** Resolve the prefabId for an equipment slot. */
export function equipPrefabId(slot: import("@voxim/codecs").EquipmentSlot | null): string | null {
  return slot?.prefabId ?? null;
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
