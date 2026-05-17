/**
 * Usable-item resolvers (T-240) — "use an item" is the generic `use_item`
 * primary-slot action; an item's payload is an `EffectSpec[]` fanned
 * through the *same* effect-resolver registry the action substrate already
 * owns. No bespoke per-item code, ever.
 *
 *   slot_has_usable — precondition gate: passes when the inventory holds a
 *     usable item (one carrying a non-empty effect payload). Generalises
 *     the retired `has_edible`.
 *
 *   apply_item_effects — fired on `apply:enter`. Resolves the first usable
 *     slot, reads the item's `EffectSpec[]` (Ph2: straight off the data —
 *     `ItemEffects` instance component for unique items, the prefab's
 *     `effects` for stackables; the Ph1 `deriveItemStats` bridge is gone),
 *     dispatches each spec back through the shared registry, then removes
 *     one from the stack / destroys the unique.
 *
 *   adjust_resource — generic `{ deltas: { <id>: <signed> } }` nudge, each
 *     clamped to its def's bounds, applied in ONE `world.set`. The map (not
 *     a single resource) is deliberate: deferred-write semantics mean two
 *     `world.set`s on the same component in one tick clobber (the second
 *     reads committed, not pending), so a fan of multiple Resource-touching
 *     effects can't compose by separate sets. One atomic multi-key effect
 *     dodges that for the food case; the general "many effects deposit onto
 *     one scalar in a tick" problem is the deposit-API design ticket
 *     (deferred — see the post-T-239 sweep).
 *
 * Replaces `consume`/`consume_item`/`has_edible`/`Edible` and the dead
 * `EquipmentSystem._handleUseItem` (destroyed the item, applied nothing) —
 * one path now, per the refactor doctrine.
 *
 * Scope (recorded in TICKETS T-240): selection is still "first usable
 * slot", not the explicit slot the `UseItem` command names — that needs a
 * per-action param channel the dispatcher doesn't have (the slot would
 * ride `ActiveActionState.scratch`, but `start()` seeds no scratch and
 * intent carries only an action id). Deferred as a substrate gap, not
 * item-effects work — a leak-prone PendingItemUse-with-slot carrier was
 * rejected as accretion.
 */

import type { World, EntityId } from "@voxim/engine";
import type { ContentService, EffectSpec } from "@voxim/content";
import type { EffectResolver, EffectRegistry, ResolveContext } from "../effect.ts";
import type { GateHandler } from "../gate.ts";
import { Resource } from "../../components/resource.ts";
import { Inventory, ItemData } from "../../components/items.ts";
import type { InventorySlot } from "../../components/items.ts";
import { ItemEffects } from "../../components/instance.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("item_use");

function slotPrefabId(slot: InventorySlot, world: World): string | null {
  if (slot.kind === "stack") return slot.prefabId;
  return world.get(slot.entityId as EntityId, ItemData)?.prefabId ?? null;
}

/**
 * The item's effect payload. Unique items carry a per-instance
 * `ItemEffects` (what procedural generation writes); stackables read the
 * prefab's `effects`. One resolution either way.
 */
function slotEffects(world: World, content: ContentService, slot: InventorySlot): EffectSpec[] {
  if (slot.kind === "unique") {
    const inst = world.get(slot.entityId as EntityId, ItemEffects);
    if (inst) return inst.effects;
  }
  const pid = slotPrefabId(slot, world);
  return (pid && content.prefabs.get(pid)?.effects) || [];
}

/** Index of the first inventory slot holding a usable (effect-bearing) item, or -1. */
function findUsableSlot(world: World, content: ContentService, entityId: EntityId): number {
  const inv = world.get(entityId, Inventory);
  if (!inv) return -1;
  return inv.slots.findIndex((s) => slotEffects(world, content, s).length > 0);
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

export const slotHasUsableGate: GateHandler = {
  id: "slot_has_usable",
  test: (ctx) => findUsableSlot(ctx.world, ctx.content, ctx.entityId) !== -1,
};

/**
 * Fans an item's `EffectSpec[]` through the shared action-effect registry.
 * Holds the registry it dispatches into (the same one it is registered in —
 * it never recurses into itself; specs name leaf effects like
 * `adjust_resource`). Class, not const, because it carries the registry —
 * same shape as `WeaponTraceResolver`.
 */
export class ApplyItemEffectsResolver implements EffectResolver {
  readonly id = "apply_item_effects";

  constructor(private readonly effects: EffectRegistry) {}

  resolve(ctx: ResolveContext): void {
    const { world, content, entityId } = ctx;
    const inv = world.get(entityId, Inventory);
    if (!inv) return;
    const idx = findUsableSlot(world, content, entityId);
    if (idx === -1) return; // raced away (gate passed at start, gone now)

    const slot = inv.slots[idx];
    const prefabId = slotPrefabId(slot, world);
    const specs = slotEffects(world, content, slot);
    for (const spec of specs) {
      this.effects.get(spec.id).resolve({ ...ctx, params: spec.params ?? {} });
    }

    world.set(entityId, Inventory, { ...inv, slots: consumeOne(world, inv.slots, idx) });
    log.info("used: entity=%s item=%s effects=%d", entityId, prefabId, specs.length);
  }
}

/**
 * Generic bounded-resource nudge. `params.deltas` maps Resource value keys
 * to signed changes; each result is clamped to that def's bounds (`min`
 * from content, `max` per-entity from the component) and all are committed
 * in one `world.set` (see the file header on why a single atomic write).
 * Keys the entity does not carry are skipped.
 */
export const adjustResourceResolver: EffectResolver = {
  id: "adjust_resource",
  resolve(ctx) {
    const { world, content, entityId, params } = ctx;
    const deltas = params.deltas;
    if (typeof deltas !== "object" || deltas === null) return;

    const res = world.get(entityId, Resource);
    if (!res) return;

    let changed = false;
    const values = { ...res.values };
    for (const [id, d] of Object.entries(deltas as Record<string, unknown>)) {
      const rv = res.values[id];
      if (!rv || typeof d !== "number") continue;
      const min = content.resources.get(id)?.bounds.min ?? 0;
      const next = Math.max(min, Math.min(rv.max, rv.value + d));
      if (next === rv.value) continue;
      values[id] = { value: next, max: rv.max };
      changed = true;
    }
    if (changed) world.set(entityId, Resource, { values });
  },
};
