/**
 * has_item gate + consume_item effect (T-337) — generic named-inventory-item
 * consumption. The ammo economy for T-338's bow/crossbow AND T-337's own
 * thrown item both reduce to "does the actor's inventory hold a stack of
 * prefab X — and if so, remove one" — no bespoke ammo system, reusing the
 * generic gate+effect registries every other action precondition/payload
 * already dispatches through (registry-dispatch doctrine).
 *
 * `params.prefabId` names the item; content decides which action pairs a
 * gate/effect with which prefab (a bow's draw action names "arrow", a
 * thrown rock's draw action names "throwing_rock") — nothing here is
 * weapon-specific.
 *
 * NPCs carry no Inventory component at all (installNpc never writes one —
 * confirmed by reading spawner.ts). `has_item` is therefore VACUOUSLY TRUE
 * for an entity with no Inventory: ammo tracking is an inventory-system
 * concept, and an entity that doesn't participate in the inventory system
 * is simply exempt from it — not a special isNpc branch, a component-
 * presence check (the same "presence as flag" doctrine the rest of the
 * combat/reaction layer already leans on). `consume_item` already no-ops
 * the same way (nothing to decrement). This is a deliberate, documented
 * scope cut: archer-type NPCs fire for free until a follow-up ticket gives
 * them a real ammo supply (mirroring how installNpc had to be taught to
 * carry stamina once action `costs` started being charged, T-255) — the
 * alternative (gate NPCs shut out entirely, since they never carry
 * Inventory) would silently turn every archer into a frozen statue the
 * moment its weapon gets a swingActionId, which is worse than "free ammo".
 */

import type { World, EntityId } from "@voxim/engine";
import { Inventory } from "../../components/items.ts";
import type { InventorySlot } from "../../components/items.ts";
import type { GateHandler } from "../gate.ts";
import type { EffectResolver } from "../effect.ts";
import { slotPrefabId, consumeOne } from "./item_use.ts";

function findItemSlot(world: World, entityId: EntityId, prefabId: string): number {
  const inv = world.get(entityId, Inventory);
  if (!inv) return -1;
  return inv.slots.findIndex((s: InventorySlot) => slotPrefabId(s, world) === prefabId);
}

export const hasItemGate: GateHandler = {
  id: "has_item",
  test(ctx) {
    const prefabId = ctx.params.prefabId;
    if (typeof prefabId !== "string" || prefabId.length === 0) return false;
    if (!ctx.world.has(ctx.entityId, Inventory)) return true; // no ammo economy for this entity
    return findItemSlot(ctx.world, ctx.entityId, prefabId) !== -1;
  },
};

export const consumeItemResolver: EffectResolver = {
  id: "consume_item",
  resolve(ctx) {
    const prefabId = ctx.params.prefabId;
    if (typeof prefabId !== "string" || prefabId.length === 0) return;
    const inv = ctx.world.get(ctx.entityId, Inventory);
    if (!inv) return; // nothing to consume — same exemption as the gate
    const idx = findItemSlot(ctx.world, ctx.entityId, prefabId);
    if (idx === -1) return; // raced away between gate check and this effect
    ctx.world.set(ctx.entityId, Inventory, { ...inv, slots: consumeOne(ctx.world, inv.slots, idx) });
  },
};
