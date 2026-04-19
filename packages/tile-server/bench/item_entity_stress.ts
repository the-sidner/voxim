/**
 * item_entity_stress — T-117 Phase 5 benchmark.
 *
 * Validates that 5000 unique item entities in inventories don't meaningfully
 * impact per-tick cost. Measures:
 *   - world.query(Inventory) + slot iteration across all inventory holders
 *   - world.query(SkillInProgress) + DurabilitySystem-style weapon lookup
 *   - world.query(ItemData) full scan (linear in item count)
 *
 * Run with:
 *   deno run --allow-read packages/tile-server/bench/item_entity_stress.ts
 */
import { World, newEntityId } from "@voxim/engine";
import { ItemData, Inventory } from "../src/components/items.ts";
import { Durability } from "../src/components/instance.ts";
import { Equipment } from "../src/components/equipment.ts";
import { SkillInProgress } from "../src/components/combat.ts";

const ITEM_COUNT = 5_000;
const HOLDER_COUNT = 100;
const WARMUP_ITERS = 10;
const BENCH_ITERS = 100;

function hrMs(): number {
  return performance.now();
}

function setup(): World {
  const world = new World();

  // Spawn item entities — unique items in inventories have no Position.
  const itemIds: string[] = [];
  for (let i = 0; i < ITEM_COUNT; i++) {
    const id = newEntityId();
    world.create(id);
    world.write(id, ItemData, { prefabId: `item_${i % 20}`, quantity: 1 });
    world.write(id, Durability, { remaining: 100, max: 100 });
    itemIds.push(id);
  }

  // Distribute into HOLDER_COUNT inventory holders (~50 items each).
  const perHolder = Math.ceil(ITEM_COUNT / HOLDER_COUNT);
  for (let h = 0; h < HOLDER_COUNT; h++) {
    const holderId = newEntityId();
    world.create(holderId);
    const slots = itemIds
      .slice(h * perHolder, (h + 1) * perHolder)
      .map((eid) => ({ kind: "unique" as const, entityId: eid }));
    world.write(holderId, Inventory, { slots, capacity: perHolder + 10 });
    world.write(holderId, Equipment, {
      weapon: null, offHand: null, head: null, chest: null,
      legs: null, feet: null, back: null,
    });
  }

  // One entity with an active swing (for DurabilitySystem path).
  const swingerId = newEntityId();
  world.create(swingerId);
  const weaponId = itemIds[0];
  world.write(swingerId, Equipment, {
    weapon: weaponId, offHand: null, head: null, chest: null,
    legs: null, feet: null, back: null,
  });
  world.write(swingerId, SkillInProgress, {
    weaponActionId: "slash",
    phase: "active",
    ticksInPhase: 0,
    hitEntities: [],
    rewindTick: 0,
    pendingSkillVerb: "",
  });

  return world;
}

function benchInventoryScan(world: World): number {
  let total = 0;
  for (const { inventory } of world.query(Inventory)) {
    for (const slot of inventory.slots) {
      if (slot.kind === "unique") total++;
    }
  }
  return total;
}

function benchItemDataScan(world: World): number {
  let total = 0;
  for (const { itemData } of world.query(ItemData)) {
    if (itemData.prefabId.length > 0) total++;
  }
  return total;
}

function benchDurabilityPath(world: World): number {
  let hits = 0;
  for (const { entityId, skillInProgress } of world.query(SkillInProgress)) {
    if (skillInProgress.phase !== "active" || skillInProgress.ticksInPhase !== 0) continue;
    const equip = world.get(entityId, Equipment);
    if (!equip?.weapon) continue;
    const dur = world.get(equip.weapon as string, Durability);
    if (dur) hits++;
  }
  return hits;
}

function measure(label: string, fn: () => unknown): void {
  // warmup
  for (let i = 0; i < WARMUP_ITERS; i++) fn();

  const times: number[] = [];
  for (let i = 0; i < BENCH_ITERS; i++) {
    const t0 = hrMs();
    fn();
    times.push(hrMs() - t0);
  }

  times.sort((a, b) => a - b);
  const avg = times.reduce((s, v) => s + v, 0) / times.length;
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const p99 = times[Math.floor(times.length * 0.99)];

  console.log(
    `${label.padEnd(30)} avg=${avg.toFixed(3)}ms  p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  p99=${p99.toFixed(3)}ms`,
  );
}

console.log(`\nitem_entity_stress — ${ITEM_COUNT} item entities, ${HOLDER_COUNT} holders\n`);

const world = setup();

measure("inventory scan (unique slots)", () => benchInventoryScan(world));
measure("ItemData full scan", () => benchItemDataScan(world));
measure("DurabilitySystem path", () => benchDurabilityPath(world));

console.log("\nBudget target: all paths < 2ms at full load (20Hz tick = 50ms budget)\n");
