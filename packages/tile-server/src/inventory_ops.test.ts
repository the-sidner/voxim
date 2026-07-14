/**
 * Pure identity-safe Inventory helpers (T-344) — the primitive every
 * `world.mutate(..., Inventory, ...)` closure in the codebase re-locates a
 * captured slot against `cur` with.
 */
import { assertEquals } from "jsr:@std/assert";
import type { InventorySlot } from "@voxim/codecs";
import { findByIdentity, removeAt, slotIdentity, slotMatches } from "./inventory_ops.ts";

const STACK: InventorySlot = { kind: "stack", prefabId: "arrow", quantity: 3 };
const UNIQUE: InventorySlot = { kind: "unique", entityId: "item-1" };

Deno.test("slotIdentity + slotMatches: stack identity matches by prefabId, ignores quantity", () => {
  const id = slotIdentity(STACK);
  assertEquals(id, { kind: "stack", prefabId: "arrow" });
  assertEquals(slotMatches({ kind: "stack", prefabId: "arrow", quantity: 999 }, id), true);
  assertEquals(slotMatches({ kind: "stack", prefabId: "bolt", quantity: 3 }, id), false);
  assertEquals(slotMatches(UNIQUE, id), false);
});

Deno.test("slotIdentity + slotMatches: unique identity matches by entityId only", () => {
  const id = slotIdentity(UNIQUE);
  assertEquals(id, { kind: "unique", entityId: "item-1" });
  assertEquals(slotMatches({ kind: "unique", entityId: "item-1" }, id), true);
  assertEquals(slotMatches({ kind: "unique", entityId: "item-2" }, id), false);
  assertEquals(slotMatches(STACK, id), false);
});

Deno.test("findByIdentity: hint-index fast path when nothing shifted", () => {
  const slots: InventorySlot[] = [STACK, UNIQUE];
  const id = slotIdentity(UNIQUE);
  assertEquals(findByIdentity(slots, id, 1), 1);
});

Deno.test("findByIdentity: falls back to a full scan after an earlier same-tick op reordered the array", () => {
  // Simulates: the hint index (0) was captured before some other op spliced
  // a slot out from in front of this one, shifting UNIQUE from index 1 to 0.
  const slots: InventorySlot[] = [UNIQUE];
  const id = slotIdentity(UNIQUE);
  assertEquals(findByIdentity(slots, id, 1), 0, "hint index 1 is now out of range/wrong — full scan recovers it");
});

Deno.test("findByIdentity: -1 when the identity is genuinely gone", () => {
  const slots: InventorySlot[] = [STACK];
  const id = slotIdentity(UNIQUE);
  assertEquals(findByIdentity(slots, id, 0), -1);
  assertEquals(findByIdentity(slots, id), -1, "no-hint form also scans and reports absence");
});

Deno.test("findByIdentity: a stale hint pointing at an unrelated slot doesn't false-match", () => {
  const slots: InventorySlot[] = [{ kind: "stack", prefabId: "bolt", quantity: 1 }, UNIQUE];
  const id = slotIdentity(UNIQUE);
  // Hint says index 0, but index 0 is a different slot now — must fall back, not false-positive.
  assertEquals(findByIdentity(slots, id, 0), 1);
});

Deno.test("removeAt: decrements a stack above the removed amount", () => {
  const slots: InventorySlot[] = [{ kind: "stack", prefabId: "arrow", quantity: 5 }];
  assertEquals(removeAt(slots, 0, 2), [{ kind: "stack", prefabId: "arrow", quantity: 3 }]);
});

Deno.test("removeAt: a stack that reaches exactly 0 is dropped, never negative", () => {
  const slots: InventorySlot[] = [{ kind: "stack", prefabId: "arrow", quantity: 2 }];
  assertEquals(removeAt(slots, 0, 2), []);
  // Over-removal doesn't go negative — same "drop the slot" outcome.
  assertEquals(removeAt(slots, 0, 99), []);
});

Deno.test("removeAt: a unique slot is removed outright (amount ignored), backing entity untouched", () => {
  const slots: InventorySlot[] = [UNIQUE];
  assertEquals(removeAt(slots, 0), []);
  assertEquals(removeAt(slots, 0, 5), [], "amount is meaningless for uniques — whole slot goes either way");
});

Deno.test("removeAt: an out-of-range index is a no-op, not a crash", () => {
  const slots: InventorySlot[] = [STACK];
  assertEquals(removeAt(slots, 5), slots);
});
