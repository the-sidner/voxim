/**
 * Pure identity-safe helpers for `Inventory` `world.mutate` closures (T-344).
 *
 * `world.mutate` closures run at COMMIT time, against whatever earlier ops
 * this tick already left behind (`World.applyChangeset` — a single
 * push-order pass over `pendingOps`, see `packages/engine/src/world.ts`) —
 * so any validation computed from a pre-closure `world.get` snapshot is
 * stale by the time the closure actually runs. These helpers let a caller
 * capture a plain-data identity token OUTSIDE the closure (where
 * `world.get`/`world.create`/`world.destroy` are still legal) and re-locate
 * that exact slot against the closure's `cur` argument, which does only
 * pure comparisons — no world access, as `world.mutate`'s contract requires.
 *
 * Load-bearing invariant every coupled pair in this codebase leans on:
 * `World.applyChangeset` walks `pendingOps` in ONE single-threaded pass, in
 * push order, invoking each `set`/`mutate`/`remove` closure synchronously
 * as it's encountered. Two `world.mutate` calls on DIFFERENT components of
 * the SAME entity, pushed from the same synchronous call (e.g. "claim the
 * destination, then move the source"), always run in that push order at
 * commit — a plain local variable closed over by both closures is a sound
 * way to couple them (COUPLED-DECLINE / claim-commit-revert). If
 * `applyChangeset` is ever parallelized or reordered, every such coupled
 * pair across the codebase breaks silently.
 */
import type { InventorySlot } from "@voxim/codecs";

/**
 * Plain-data identity for one inventory slot — a stack is fungible
 * (identified by prefabId alone; quantity is re-read live), a unique slot
 * is identified by its backing entityId.
 */
export type SlotIdentity =
  | { kind: "stack"; prefabId: string }
  | { kind: "unique"; entityId: string };

export function slotIdentity(slot: InventorySlot): SlotIdentity {
  return slot.kind === "stack"
    ? { kind: "stack", prefabId: slot.prefabId }
    : { kind: "unique", entityId: slot.entityId };
}

/** True when `slot` matches the captured identity. */
export function slotMatches(slot: InventorySlot, id: SlotIdentity): boolean {
  if (slot.kind !== id.kind) return false;
  return id.kind === "stack"
    ? slot.kind === "stack" && slot.prefabId === id.prefabId
    : slot.kind === "unique" && slot.entityId === id.entityId;
}

/**
 * Re-locate a captured identity inside `slots` at commit time. Checks
 * `hintIndex` first (the common case — nothing else touched this entity's
 * Inventory this tick, so the captured index is still valid), then falls
 * back to a full scan (an earlier same-tick op may have spliced the array
 * and shifted indices). Returns -1 when the identity is genuinely gone —
 * already removed or moved by an earlier same-tick op — callers decline
 * (`return cur` unchanged) on -1.
 */
export function findByIdentity(slots: InventorySlot[], id: SlotIdentity, hintIndex?: number): number {
  if (hintIndex !== undefined && hintIndex >= 0 && hintIndex < slots.length && slotMatches(slots[hintIndex], id)) {
    return hintIndex;
  }
  return slots.findIndex((s) => slotMatches(s, id));
}

/**
 * Pure removal of `amount` units at `idx` (default 1, i.e. "the whole
 * slot" for a unique). Stacks: decrements, dropping the slot once it
 * reaches 0. Uniques: always removes the whole slot — never destroys the
 * backing entity itself. Callers that need the entity gone must call
 * `world.destroy` themselves BEFORE pushing the mutate (a mutate closure
 * may not touch the world) and accept the documented orphan-on-decline
 * residual that follows from doing so.
 */
export function removeAt(slots: InventorySlot[], idx: number, amount = 1): InventorySlot[] {
  const slot = slots[idx];
  if (!slot) return slots;
  if (slot.kind === "unique") return slots.filter((_, i) => i !== idx);
  const remaining = slot.quantity - amount;
  if (remaining <= 0) return slots.filter((_, i) => i !== idx);
  return slots.map((s, i) => (i === idx ? { ...s, quantity: remaining } : s));
}
