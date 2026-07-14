/**
 * BlueprintHitHandler — materials consumption + construction progress
 * (T-344). No test file existed for this handler before. Direct unit
 * tests (onHit called directly, no sweep-dispatch machinery needed — the
 * handler only reads ctx.attackerId/targetId/weaponStats).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import { Inventory } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { Blueprint } from "../components/building.ts";
import type { BlueprintData } from "../components/building.ts";
import type { HitContext } from "../hit_handler.ts";
import { BlueprintHitHandler } from "./blueprint_hit_handler.ts";

function hammerCtx(attackerId: EntityId, targetId: EntityId, buildPower = 5): HitContext {
  return {
    attackerId, targetId,
    weaponStats: { weight: 1, toolType: "hammer", buildPower },
    bodyPart: "body",
    attackerPart: "mid",
    targetSnapshotFacing: 0,
    attackerX: 0, attackerY: 0, targetX: 0, targetY: 0,
    hitX: 0, hitY: 0, hitZ: 0,
    parryAllowed: true,
  };
}

function attacker(world: World, slots: InventorySlot[]): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Inventory, { slots, capacity: 20 });
  return id;
}

const BASE_BLUEPRINT: BlueprintData = {
  structureType: "wood_wall",
  chunkX: 0, chunkY: 0, localX: 0, localY: 0,
  heightDelta: 0, materialId: 1,
  materialCost: [{ itemType: "birch_wood", quantity: 4 }],
  totalTicks: 100, ticksRemaining: 100,
  materialsDeducted: false,
};

function blueprint(world: World, overrides: Partial<BlueprintData> = {}): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Blueprint, { ...BASE_BLUEPRINT, ...overrides });
  return id;
}

Deno.test("onHit: a single attacker with sufficient materials starts construction normally", () => {
  const w = new World();
  const handler = new BlueprintHitHandler();
  const a = attacker(w, [{ kind: "stack", prefabId: "birch_wood", quantity: 4 }]);
  const bp = blueprint(w);

  handler.onHit(w, new EventBus(), hammerCtx(a, bp));
  w.applyChangeset();

  assertEquals(w.get(bp, Blueprint)!.materialsDeducted, true);
  assertEquals(w.get(a, Inventory)!.slots.length, 0, "materials consumed");
});

Deno.test("onHit: declines and leaves materialsDeducted false when the attacker lacks materials", () => {
  const w = new World();
  const handler = new BlueprintHitHandler();
  const a = attacker(w, [{ kind: "stack", prefabId: "birch_wood", quantity: 1 }]); // needs 4
  const bp = blueprint(w);

  handler.onHit(w, new EventBus(), hammerCtx(a, bp));
  w.applyChangeset();

  assertEquals(w.get(bp, Blueprint)!.materialsDeducted, false, "the revert leg: claimed then reverted, never stuck true for nothing");
  assertEquals(w.get(a, Inventory)!.slots, [{ kind: "stack", prefabId: "birch_wood", quantity: 1 }], "nothing taken");
});

Deno.test("T-344: two DIFFERENT attackers land the first hit on one fresh blueprint in the same simulated tick — exactly one is charged, the other's materials are untouched", () => {
  const w = new World();
  const handler = new BlueprintHitHandler();
  const attackerA = attacker(w, [{ kind: "stack", prefabId: "birch_wood", quantity: 4 }]);
  const attackerB = attacker(w, [{ kind: "stack", prefabId: "birch_wood", quantity: 4 }]);
  const bp = blueprint(w);

  // Both hits resolve before either commits — the same-tick shape.
  handler.onHit(w, new EventBus(), hammerCtx(attackerA, bp));
  handler.onHit(w, new EventBus(), hammerCtx(attackerB, bp));
  w.applyChangeset();

  assertEquals(w.get(bp, Blueprint)!.materialsDeducted, true, "claimed exactly once — never double-flipped");
  const aSpent = w.get(attackerA, Inventory)!.slots.length === 0;
  const bSpent = w.get(attackerB, Inventory)!.slots.length === 0;
  assert(aSpent !== bSpent, "exactly one attacker was charged — never both, never neither");
});

Deno.test("onHit: advancing construction — a single hit subtracts buildPower from ticksRemaining", () => {
  const w = new World();
  const handler = new BlueprintHitHandler();
  const a = attacker(w, []);
  const bp = blueprint(w, { materialsDeducted: true, ticksRemaining: 50 });

  handler.onHit(w, new EventBus(), hammerCtx(a, bp, 5));
  w.applyChangeset();

  assertEquals(w.get(bp, Blueprint)!.ticksRemaining, 45);
});

Deno.test("T-344: two attackers hammering the SAME blueprint in one tick both subtract from ticksRemaining (composing, not clobbering)", () => {
  const w = new World();
  const handler = new BlueprintHitHandler();
  const attackerA = attacker(w, []);
  const attackerB = attacker(w, []);
  const bp = blueprint(w, { materialsDeducted: true, ticksRemaining: 50 });

  handler.onHit(w, new EventBus(), hammerCtx(attackerA, bp, 5));
  handler.onHit(w, new EventBus(), hammerCtx(attackerB, bp, 3));
  w.applyChangeset();

  assertEquals(w.get(bp, Blueprint)!.ticksRemaining, 42, "both hits' buildPower landed (50 - 5 - 3), not last-write-wins (50 - 3)");
});

Deno.test("onHit: construction completes, applies terrain, destroys the blueprint entity", () => {
  const w = new World();
  const handler = new BlueprintHitHandler();
  const a = attacker(w, []);
  const bp = blueprint(w, { materialsDeducted: true, ticksRemaining: 3 });

  handler.onHit(w, new EventBus(), hammerCtx(a, bp, 5));
  w.applyChangeset();

  assertEquals(w.isAlive(bp), false, "blueprint entity destroyed on completion");
});
