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
 * silently clobbering one). Each op is COUPLED-DECLINE across the two
 * components it moves an item between, but which side gates FIRST has to
 * be whichever side is the actually-SHARED/contested resource — "the
 * destination always gates first" is not a safe universal rule, and this
 * file initially got it wrong for withdraw (found + fixed in the same
 * ticket, see below):
 *
 *  - store: Container (the destination) IS the shared resource — many
 *    actors' deposits target the SAME chest's capacity, but each deposits
 *    FROM their own private Inventory. Destination-first is correct here:
 *    the chest claims a slot, the depositor's own Inventory removal is
 *    dependent on that claim.
 *  - withdraw: Container (the SOURCE) is the shared resource this time —
 *    many actors can race to withdraw the SAME banked item, but each
 *    withdraws INTO their own private Inventory (never shared). Gating on
 *    the destination first, as store does, does not arbitrate the real
 *    race at all: two different dynasty members withdrawing the SAME slot
 *    in the same tick — ordinary play, no contradictory commands from one
 *    client needed — each had their own private-Inventory capacity claim
 *    succeed (nothing about "does MY inventory have room" contends with
 *    the OTHER actor), duplicating the item before either op's
 *    Container-side check ran. Fixed with 3-closure claim/commit/revert
 *    (same shape as `blueprint_hit_handler.ts`'s materials claim):
 *    Container claims (removes) the item FIRST via TARGETED-DECLINE;
 *    Inventory's grant is dependent on that claim AND does its own
 *    commit-time capacity recheck; Container reverts (re-adds the slot)
 *    if the holder turned out to have no room, so a losing race never
 *    strands the item mid-air — it just stays banked, never the
 *    "consumed material with no output" case this ticket's bar treats as
 *    unacceptable.
 *
 * Residual left open (documented, not papered over): a SECOND same-tick
 * command independently touching the exact same captured item (e.g. one
 * client issuing two contradictory commands against it in one batch)
 * is bounded to that compound case, not the ordinary two-different-writers
 * race this ticket targets — that race is now closed on both store and
 * withdraw.
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

  // T-344 follow-up: 3-closure claim/commit/revert — Container (the
  // SOURCE) is the actually-shared/contested resource here (see the file
  // header): it claims (removes) the item FIRST via TARGETED-DECLINE.
  // Inventory's grant is dependent on that claim AND does its own
  // commit-time capacity recheck; if the holder turns out to have no
  // room, Container reverts (re-adds the slot) instead of the item
  // vanishing. Destination-first (claiming the holder's private,
  // uncontested Inventory capacity before the actually-contested
  // Container slot) let two different actors both "win" a race to
  // withdraw the SAME item — see container_ops.test.ts's same-slot
  // regression.
  let claimed = false;
  world.mutate(containerId, Container, (cur) => {
    const idx = cur.slots.findIndex((s) => s.entityId === itemEntityId);
    if (idx === -1) return cur; // already withdrawn by an earlier same-tick op
    claimed = true;
    return { ...cur, slots: cur.slots.filter((_, i) => i !== idx) };
  });
  let granted = false;
  world.mutate(intoHolderId, Inventory, (cur) => {
    if (!claimed) return cur;
    if (cur.slots.length >= cur.capacity) return cur;
    granted = true;
    return { ...cur, slots: [...cur.slots, { kind: "unique" as const, entityId: itemEntityId }] };
  });
  world.mutate(containerId, Container, (cur) => {
    if (!claimed || granted) return cur;
    // Holder had no room after all — revert the claim, item stays banked.
    return { ...cur, slots: [...cur.slots, { entityId: itemEntityId }] };
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
