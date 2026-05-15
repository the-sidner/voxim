/**
 * consume_item effect + has_edible gate (T-230).
 *
 * "Consume" is now the `consume` primary-slot action: `has_edible` gates
 * the action from starting when there's nothing to eat, and the
 * `consume_item` effect (fired on `ingest:enter`) does what the retired
 * ConsumptionSystem did — pick the first edible inventory slot, derive its
 * stats, drain Hunger/Thirst, and remove one from the stack/destroy the
 * unique. Eating is therefore animation-paced (one item per action) rather
 * than one-per-tick-held; the rate change is accepted retune.
 *
 * (Interact / pray from the plan's T-230 line are no-ops: ACTION_INTERACT
 * was retired — pickups are hover commands — and no prayer mechanic exists.
 * Nothing to migrate; recorded so the scope delta is explicit.)
 */

import type { World, EntityId } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import type { EffectResolver } from "../effect.ts";
import type { GateHandler } from "../gate.ts";
import { Resource } from "../../components/resource.ts";
import { Inventory, ItemData } from "../../components/items.ts";
import type { InventorySlot } from "../../components/items.ts";
import { QualityStamped } from "../../components/instance.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("consume");

function slotPrefabId(slot: InventorySlot, world: World): string | null {
  if (slot.kind === "stack") return slot.prefabId;
  return world.get(slot.entityId as EntityId, ItemData)?.prefabId ?? null;
}

/** Index of the first inventory slot holding an `edible` prefab, or -1. */
function findEdibleSlot(world: World, content: ContentService, entityId: EntityId): number {
  const inv = world.get(entityId, Inventory);
  if (!inv) return -1;
  return inv.slots.findIndex((s) => {
    const pid = slotPrefabId(s, world);
    return !!pid && !!content.prefabs.get(pid)?.components["edible"];
  });
}

function consumeOne(world: World, slots: InventorySlot[], idx: number): InventorySlot[] {
  const slot = slots[idx];
  if (slot.kind === "stack") {
    if (slot.quantity <= 1) return slots.filter((_, i) => i !== idx);
    return slots.map((s, i) => i === idx
      ? { kind: "stack" as const, prefabId: slot.prefabId, quantity: slot.quantity - 1 }
      : s);
  }
  world.destroy(slot.entityId as EntityId);
  return slots.filter((_, i) => i !== idx);
}

export const hasEdibleGate: GateHandler = {
  id: "has_edible",
  test: (ctx) => findEdibleSlot(ctx.world, ctx.content, ctx.entityId) !== -1,
};

export const consumeItemResolver: EffectResolver = {
  id: "consume_item",
  resolve(ctx) {
    const { world, content, entityId } = ctx;
    const inv = world.get(entityId, Inventory);
    if (!inv) return;
    const idx = findEdibleSlot(world, content, entityId);
    if (idx === -1) return; // raced away (gate passed at start, gone now)

    const slot = inv.slots[idx];
    const prefabId = slotPrefabId(slot, world)!;
    const quality = slot.kind === "unique"
      ? world.get(slot.entityId as EntityId, QualityStamped)?.quality ?? 1
      : 1;
    const stats = content.deriveItemStats(prefabId, [], quality);

    const res = world.get(entityId, Resource);
    if (res && ((stats.foodValue ?? 0) > 0 || (stats.waterValue ?? 0) > 0)) {
      const values = { ...res.values };
      const h = values.hunger;
      if (h && (stats.foodValue ?? 0) > 0) {
        values.hunger = { value: Math.max(0, h.value - stats.foodValue!), max: h.max };
      }
      const t = values.thirst;
      if (t && (stats.waterValue ?? 0) > 0) {
        values.thirst = { value: Math.max(0, t.value - stats.waterValue!), max: t.max };
      }
      world.set(entityId, Resource, { values });
    }

    world.set(entityId, Inventory, { ...inv, slots: consumeOne(world, inv.slots, idx) });
    log.info("consumed: entity=%s item=%s food=%.1f water=%.1f",
      entityId, prefabId, stats.foodValue ?? 0, stats.waterValue ?? 0);
  },
};
