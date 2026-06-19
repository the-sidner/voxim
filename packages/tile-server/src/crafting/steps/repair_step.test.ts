/**
 * Repair step (T-088) — a worn item on the anvil + an iron ingot + a hammer-hit
 * restores durability and consumes the ingot; the item itself is kept. Runs
 * against real content (data/recipes/repair_metal.json: +40, station "anvil").
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Durability } from "../../components/instance.ts";
import { WorkstationTag, WorkstationBuffer } from "../../components/building.ts";
import type { WorkstationBufferData } from "@voxim/codecs";
import { ItemData } from "../../components/items.ts";
import { repairStep } from "./repair_step.ts";
import type { RecipeHitContext } from "../step_handler.ts";

const content = await JsonSource.load();

function setup(remaining: number, materials: boolean, recipeId = "repair_metal") {
  const w = new World();
  const item = newEntityId();
  w.create(item);
  w.write(item, ItemData, { prefabId: "iron_sword", quantity: 1 });
  w.write(item, Durability, { remaining, max: 100 });

  const anvil = newEntityId();
  w.create(anvil);
  w.write(anvil, WorkstationTag, { stationType: "anvil", qualityTier: 1 });
  const slots: WorkstationBufferData["slots"] = [
    { kind: "unique", entityId: item, prefabId: "iron_sword" },
  ];
  if (materials) slots.push({ kind: "stack", itemType: "iron_ingot", quantity: 1 });
  const buffer: WorkstationBufferData = { capacity: 4, activeRecipeId: recipeId, slots };
  w.write(anvil, WorkstationBuffer, buffer);
  return { w, item, anvil, buffer };
}

function hit(w: World, anvil: string, buffer: WorkstationBufferData, toolType: string): RecipeHitContext {
  return {
    world: w, events: new EventBus(), content,
    stationId: anvil, stationType: "anvil", buffer,
    hit: { attackerId: "player-1", weaponStats: { toolType } },
  } as unknown as RecipeHitContext;
}

function hasIngot(w: World, anvil: string): boolean {
  return (w.get(anvil, WorkstationBuffer)!.slots.filter(Boolean) as Array<{ kind: string; itemType?: string }>)
    .some((s) => s.kind === "stack" && s.itemType === "iron_ingot");
}

Deno.test("repair: restores durability and consumes the ingot, keeps the item", () => {
  const { w, item, anvil, buffer } = setup(20, true);
  repairStep.onHit!(hit(w, anvil, buffer, "hammer"));
  w.applyChangeset();

  assertEquals(w.get(item, Durability)!.remaining, 60, "20 + repairAmount 40");
  assert(!hasIngot(w, anvil), "the ingot was consumed");
  const slots = w.get(anvil, WorkstationBuffer)!.slots.filter(Boolean) as Array<{ kind: string; entityId?: string }>;
  assert(slots.some((s) => s.kind === "unique" && s.entityId === item), "the repaired item stays in the buffer");
});

Deno.test("repair: caps at max — repeated repairs never overfill", () => {
  const { w, item, anvil, buffer } = setup(80, true);
  repairStep.onHit!(hit(w, anvil, buffer, "hammer"));
  w.applyChangeset();
  assertEquals(w.get(item, Durability)!.remaining, 100, "80 + 40 capped at max 100");
});

Deno.test("repair: no material → no repair, nothing consumed", () => {
  const { w, item, anvil, buffer } = setup(20, false);
  repairStep.onHit!(hit(w, anvil, buffer, "hammer"));
  w.applyChangeset();
  assertEquals(w.get(item, Durability)!.remaining, 20, "unchanged without the ingot");
});

Deno.test("repair: wrong tool → no repair", () => {
  const { w, item, anvil, buffer } = setup(20, true);
  repairStep.onHit!(hit(w, anvil, buffer, "axe"));
  w.applyChangeset();
  assertEquals(w.get(item, Durability)!.remaining, 20);
  assert(hasIngot(w, anvil), "material not consumed on a no-op");
});

Deno.test("repair: a full-durability item is left alone (material not wasted)", () => {
  const { w, item, anvil, buffer } = setup(100, true);
  repairStep.onHit!(hit(w, anvil, buffer, "hammer"));
  w.applyChangeset();
  assertEquals(w.get(item, Durability)!.remaining, 100);
  assert(hasIngot(w, anvil), "nothing to repair → ingot kept");
});
