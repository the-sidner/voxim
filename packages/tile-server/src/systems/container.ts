/**
 * Container store/withdraw operations (T-077/T-078) — moving a UNIQUE item
 * entity between an actor's `Inventory` and a deployed family chest's
 * `Container`.
 *
 * These are transactional helpers, NOT a per-tick System: chests do nothing
 * between deposits, so store/withdraw are command-driven one-shot ops (the same
 * shape as `stampOwnershipAndCapture` / `destroyCarriedItemEntities`). v1 callers
 * are the tests + the future deposit/withdraw command handler; writes are
 * immediate (`world.write`) like the deploy-time ownership stamp.
 *
 * Invariant in both directions: the op MOVES an entity ref — it never copies or
 * destroys the item entity, so the tome's `Inscribed` / the weapon's
 * `Durability`/`QualityStamped` ride along untouched.
 *
 * Gates: a chest is dynasty-locked (`Container.dynastyId`, stamped on deploy) and
 * kind-locked (a library takes only tomes; a treasury takes only equippable gear).
 */
import type { World, EntityId } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import { Container } from "../components/container.ts";
import { Inventory, ItemData } from "../components/items.ts";
import { Heritage } from "../components/heritage.ts";

export type ContainerOpResult =
  | { ok: true; slotIndex: number }
  | { ok: false; reason: string };

/** Does a chest of `kind` accept an item of `prefabId`? */
function kindAccepts(content: ContentService, kind: string, prefabId: string): boolean {
  const tomeType = content.getGameConfig().lore.tomeItemType;
  if (kind === "tome") return prefabId === tomeType;
  // equipment: any equippable prefab that isn't the tome.
  const prefab = content.prefabs.get(prefabId);
  return !!prefab && prefabId !== tomeType && "equippable" in (prefab.components ?? {});
}

/** True when `actor`'s dynasty owns `container` (and ownership is established). */
function actorOwns(world: World, actorId: EntityId, dynastyId: string): boolean {
  const actorDyn = world.get(actorId, Heritage)?.dynastyId;
  return !!actorDyn && actorDyn === dynastyId;
}

/**
 * Move a unique item the actor holds in their `Inventory` into the chest's
 * `Container`. Rejects on wrong dynasty, wrong kind, a full chest, or an item
 * the actor isn't actually holding as a unique slot.
 */
export function storeInContainer(
  world: World,
  content: ContentService,
  actorId: EntityId,
  containerId: EntityId,
  itemEntityId: EntityId,
): ContainerOpResult {
  const container = world.get(containerId, Container);
  if (!container) return { ok: false, reason: "not-a-container" };
  if (!actorOwns(world, actorId, container.dynastyId)) return { ok: false, reason: "wrong-dynasty" };
  if (container.slots.length >= container.capacity) return { ok: false, reason: "container-full" };

  const inv = world.get(actorId, Inventory);
  if (!inv) return { ok: false, reason: "actor-has-no-inventory" };
  const held = inv.slots.some((s) => s.kind === "unique" && s.entityId === itemEntityId);
  if (!held) return { ok: false, reason: "item-not-held" };

  const item = world.get(itemEntityId, ItemData);
  if (!item) return { ok: false, reason: "not-an-item-entity" };
  if (!kindAccepts(content, container.kind, item.prefabId)) return { ok: false, reason: "wrong-kind" };

  // Entity-ref MOVE: drop the inventory ref, push the chest ref.
  world.write(actorId, Inventory, {
    ...inv,
    slots: inv.slots.filter((s) => !(s.kind === "unique" && s.entityId === itemEntityId)),
  });
  const slotIndex = container.slots.length;
  world.write(containerId, Container, {
    ...container,
    slots: [...container.slots, { entityId: itemEntityId }],
  });
  return { ok: true, slotIndex };
}

/**
 * Move a banked item out of the chest's `Container` back into `intoHolder`'s
 * `Inventory` (usually the acting heir). Rejects on wrong dynasty, a bad slot
 * index, or a full target inventory.
 */
export function withdrawFromContainer(
  world: World,
  actorId: EntityId,
  containerId: EntityId,
  slotIndex: number,
  intoHolderId: EntityId,
): ContainerOpResult {
  const container = world.get(containerId, Container);
  if (!container) return { ok: false, reason: "not-a-container" };
  if (!actorOwns(world, actorId, container.dynastyId)) return { ok: false, reason: "wrong-dynasty" };
  if (slotIndex < 0 || slotIndex >= container.slots.length) return { ok: false, reason: "bad-slot" };

  const inv = world.get(intoHolderId, Inventory);
  if (!inv) return { ok: false, reason: "holder-has-no-inventory" };
  if (inv.slots.length >= inv.capacity) return { ok: false, reason: "inventory-full" };

  const itemEntityId = container.slots[slotIndex].entityId;

  // Entity-ref MOVE: pull the chest ref, push the inventory unique ref.
  world.write(containerId, Container, {
    ...container,
    slots: container.slots.filter((_, i) => i !== slotIndex),
  });
  world.write(intoHolderId, Inventory, {
    ...inv,
    slots: [...inv.slots, { kind: "unique" as const, entityId: itemEntityId }],
  });
  return { ok: true, slotIndex };
}
