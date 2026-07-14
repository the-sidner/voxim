/**
 * Container store/withdraw operations (T-077/T-078) — moving a UNIQUE item
 * entity between an actor's `Inventory` and a deployed family chest's
 * `Container`.
 *
 * `storeInContainer` / `withdrawFromContainer` are transactional helpers that
 * `ContainerSystem` (below) drives from the deposit/withdraw commands — chests
 * do nothing between deposits, so they're command-driven one-shot ops. The
 * mutations use `world.mutate` (T-344), so the Container/Inventory changes land
 * in the tick's changeset and ship to the client as deltas — an immediate
 * `world.write` would mutate the store but never produce a delta for an
 * already-known chest.
 *
 * T-344: a family chest is genuinely touched by MULTIPLE different dynasty
 * members' sessions in the same tick — get-then-set here was the same
 * lost-update shape as everywhere else (two same-tick deposits into a
 * near-full chest could both read "room for one more" and both write,
 * silently clobbering one). Each op is now COUPLED-DECLINE across the two
 * components it moves an item between: the DESTINATION component's mutate
 * runs first (its own recheck against commit-time state — capacity for a
 * store, capacity for a withdraw), and the SOURCE component's removal is
 * dependent on that claim succeeding, re-locating the item by identity
 * rather than trusting a raw index (an earlier same-tick op on the SAME
 * chest may have spliced a slot out from under it). Putting the destination
 * first means the FAILURE mode this ticket's own bar treats as unacceptable
 * ("a consumed material with no output") is closed on both sides — the item
 * is only ever removed from its source once it has already landed at the
 * destination. The residual this can't close without a cross-component
 * transaction primitive: if the exact SAME captured item is independently
 * moved by a SECOND same-tick command (e.g. deposited AND traded away in
 * one tick — needs two contradictory commands from one client), the
 * destination's claim can commit before the source-side identity re-check
 * discovers the item is gone, producing a narrow duplicate ref. Documented,
 * not papered over — see the two functions below.
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
import { findByIdentity } from "../inventory_ops.ts";
import type { SlotIdentity } from "../inventory_ops.ts";
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

  // T-344: COUPLED-DECLINE — Container (the destination) claims a slot
  // first, its own recheck against commit-time state; Inventory's removal
  // (the source) is dependent on that claim and re-locates the item by
  // identity rather than trusting a snapshot index. See the file header.
  const identity: SlotIdentity = { kind: "unique", entityId: itemEntityId };
  let claimed = false;
  world.mutate(containerId, Container, (cur) => {
    if (cur.slots.length >= cur.capacity) return cur;
    claimed = true;
    return { ...cur, slots: [...cur.slots, { entityId: itemEntityId }] };
  });
  world.mutate(actorId, Inventory, (cur) => {
    if (!claimed) return cur;
    const idx = findByIdentity(cur.slots, identity);
    if (idx === -1) return cur;
    return { ...cur, slots: cur.slots.filter((_, i) => i !== idx) };
  });
  return { ok: true, slotIndex: container.slots.length };
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
    // A dangling slot (the banked entity died) — purge it rather than hand
    // the holder a dead ref. (Save skips dead refs but keeps the slot
    // string.) Single-component TARGETED-DECLINE: re-locate by identity
    // rather than trusting slotIndex, since an earlier same-tick op on this
    // SAME chest could have spliced a different slot out from under it.
    world.mutate(containerId, Container, (cur) => {
      const idx = cur.slots.findIndex((s) => s.entityId === itemEntityId);
      if (idx === -1) return cur; // already purged/withdrawn by an earlier same-tick op
      return { ...cur, slots: cur.slots.filter((_, i) => i !== idx) };
    });
    return { ok: false, reason: "slot-item-dead" };
  }

  const inv = world.get(intoHolderId, Inventory);
  if (!inv) return { ok: false, reason: "holder-has-no-inventory" };
  if (inv.slots.length >= inv.capacity) return { ok: false, reason: "inventory-full" };

  // T-344: COUPLED-DECLINE — Inventory (the destination) claims capacity
  // first; Container's removal (the source) is dependent on that claim and
  // re-locates the item by identity. Destination-first closes the "removed
  // from the chest but the holder never received it" loss case; see the
  // file header for the residual this still leaves open.
  let claimed = false;
  world.mutate(intoHolderId, Inventory, (cur) => {
    if (cur.slots.length >= cur.capacity) return cur;
    claimed = true;
    return { ...cur, slots: [...cur.slots, { kind: "unique" as const, entityId: itemEntityId }] };
  });
  world.mutate(containerId, Container, (cur) => {
    if (!claimed) return cur;
    const idx = cur.slots.findIndex((s) => s.entityId === itemEntityId);
    if (idx === -1) return cur;
    return { ...cur, slots: cur.slots.filter((_, i) => i !== idx) };
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
