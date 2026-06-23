/**
 * Container store/withdraw operations (T-077/T-078) — moving a UNIQUE item
 * entity between an actor's `Inventory` and a deployed family chest's
 * `Container`.
 *
 * `storeInContainer` / `withdrawFromContainer` are transactional helpers that
 * `ContainerSystem` (below) drives from the deposit/withdraw commands — chests
 * do nothing between deposits, so they're command-driven one-shot ops. The
 * mutations use `world.set` (deferred), so the Container/Inventory changes land
 * in the tick's changeset and ship to the client as deltas — an immediate
 * `world.write` would mutate the store but never produce a delta for an
 * already-known chest. Read-then-set with no read-after-write, so a single op is
 * clean; two ops to one chest in a tick last-write-win like the equipment path.
 *
 * Invariant in both directions: the op MOVES an entity ref — it never copies or
 * destroys the item entity, so the tome's `Inscribed` / the weapon's
 * `Durability`/`QualityStamped` ride along untouched.
 *
 * Gates: a chest is dynasty-locked (`Container.dynastyId`, stamped on deploy) and
 * kind-locked (a library takes only tomes; a treasury takes only equippable gear).
 * Proximity is gated by `ContainerSystem` (the command path), not the helpers —
 * the save/op tests deploy chests at the origin with position-less actors.
 */
import type { World, EntityId } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Container } from "../components/container.ts";
import { Inventory, ItemData } from "../components/items.ts";
import { Position } from "../components/game.ts";
import { Heritage } from "../components/heritage.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ContainerSystem");

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
  world.set(actorId, Inventory, {
    ...inv,
    slots: inv.slots.filter((s) => !(s.kind === "unique" && s.entityId === itemEntityId)),
  });
  const slotIndex = container.slots.length;
  world.set(containerId, Container, {
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
  // The destination must ALSO be of the owning dynasty — the authoriser doesn't
  // get to deposit heritage gear into an arbitrary third entity (cross-dynasty
  // siphon). In v1 the holder is the actor; this keeps it honest for the future
  // command handler where the two ids could diverge.
  if (!actorOwns(world, intoHolderId, container.dynastyId)) return { ok: false, reason: "holder-wrong-dynasty" };
  if (slotIndex < 0 || slotIndex >= container.slots.length) return { ok: false, reason: "bad-slot" };

  const itemEntityId = container.slots[slotIndex].entityId;
  if (!world.isAlive(itemEntityId)) {
    // A dangling slot (the banked entity died) — purge it rather than hand the
    // holder a dead ref. (Save skips dead refs but keeps the slot string.)
    world.set(containerId, Container, { ...container, slots: container.slots.filter((_, i) => i !== slotIndex) });
    return { ok: false, reason: "slot-item-dead" };
  }

  const inv = world.get(intoHolderId, Inventory);
  if (!inv) return { ok: false, reason: "holder-has-no-inventory" };
  if (inv.slots.length >= inv.capacity) return { ok: false, reason: "inventory-full" };

  // Entity-ref MOVE: pull the chest ref, push the inventory unique ref.
  world.set(containerId, Container, {
    ...container,
    slots: container.slots.filter((_, i) => i !== slotIndex),
  });
  world.set(intoHolderId, Inventory, {
    ...inv,
    slots: [...inv.slots, { kind: "unique" as const, entityId: itemEntityId }],
  });
  return { ok: true, slotIndex };
}

/**
 * ContainerSystem — drains the deposit/withdraw commands and routes them through
 * the store/withdraw helpers, mirroring `EquipmentSystem`'s command shape. Adds a
 * proximity gate (the helpers are position-agnostic): the actor must be within
 * `crafting.interactRange` of the chest — the same reach the client's
 * `_openContainer` enforces before opening the panel, so a forged far-away
 * command is refused server-side.
 *
 * Deposit carries an inventory slot index (matching Equip); only a UNIQUE-entity
 * slot can bank (chests hold entity refs, never stacks), so a stack drag no-ops.
 * Withdraw banks the chest slot back into the acting player's own inventory.
 */
export class ContainerSystem implements System {
  private _commands: ReadonlyMap<string, CommandPayload[]> = new Map();

  constructor(private readonly content: ContentService) {}

  prepare(_serverTick: number, ctx: TickContext): void {
    this._commands = ctx.pendingCommands;
  }

  run(world: World, _events: EventEmitter, _dt: number): void {
    const reach = this.content.getGameConfig().crafting.interactRange;
    for (const [actorId, commands] of this._commands) {
      if (!world.isAlive(actorId)) continue;
      for (const cmd of commands) {
        if (cmd.cmd === CommandType.ContainerDeposit) {
          this._deposit(world, actorId, cmd.containerId, cmd.fromInventorySlot, reach);
        } else if (cmd.cmd === CommandType.ContainerWithdraw) {
          this._withdraw(world, actorId, cmd.containerId, cmd.slotIndex, reach);
        }
      }
    }
  }

  /** True when the actor is within `reach` world units of the chest. */
  private _inReach(world: World, actorId: EntityId, containerId: EntityId, reach: number): boolean {
    const a = world.get(actorId, Position);
    const c = world.get(containerId, Position);
    if (!a || !c) return false;
    const dx = a.x - c.x, dy = a.y - c.y;
    return dx * dx + dy * dy <= reach * reach;
  }

  private _deposit(world: World, actorId: EntityId, containerId: string, fromInventorySlot: number, reach: number): void {
    if (!this._inReach(world, actorId, containerId as EntityId, reach)) return;
    const inv = world.get(actorId, Inventory);
    const slot = inv?.slots[fromInventorySlot];
    // Only unique-entity items bank — a stack carries no per-instance entity to move.
    if (slot?.kind !== "unique") return;
    const r = storeInContainer(world, this.content, actorId, containerId as EntityId, slot.entityId as EntityId);
    if (!r.ok) log.debug("deposit rejected: actor=%s chest=%s reason=%s", actorId, containerId, r.reason);
  }

  private _withdraw(world: World, actorId: EntityId, containerId: string, slotIndex: number, reach: number): void {
    if (!this._inReach(world, actorId, containerId as EntityId, reach)) return;
    const r = withdrawFromContainer(world, actorId, containerId as EntityId, slotIndex, actorId);
    if (!r.ok) log.debug("withdraw rejected: actor=%s chest=%s slot=%d reason=%s", actorId, containerId, slotIndex, r.reason);
  }
}
