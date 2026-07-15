/**
 * CraftAtWorkbench's "place" phase — transferInputsToBuffer moves items from
 * the NPC's Inventory into the workstation's WorkstationBuffer (T-344). No
 * test file existed for this job before.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Position } from "../../components/game.ts";
import { Inventory } from "../../components/items.ts";
import { WorkstationTag, WorkstationBuffer } from "../../components/building.ts";
import { craftAtWorkbenchJob } from "./craft_at_workbench.ts";
import type { JobContext, JobTickInput } from "../job_handler.ts";
import type { Job } from "../../components/npcs.ts";

const content = await JsonSource.load();

function ctxFor(world: World, entityId: string, x: number, y: number): JobContext {
  return {
    world,
    entityId,
    pos: { x, y },
    spatial: null as unknown as JobContext["spatial"],
    content,
    currentTick: 0,
    tuning: { attackRangeSq: 2.25 } as unknown as JobContext["tuning"],
    defaults: content.getGameConfig().npcAiDefaults,
  };
}

function craftJob(over: Partial<Extract<Job, { type: "craftAtWorkbench" }>> = {}): Job {
  return {
    type: "craftAtWorkbench",
    workbenchType: "workbench",
    inputs: [{ itemType: "iron_ore", quantity: 2 }],
    workbenchId: null,
    phase: "place",
    expiresAt: 100,
    ...over,
  };
}

function input(ctx: JobContext, job: Job): JobTickInput {
  return { ctx, job, plan: null, planDirX: 0, planDirY: 0 };
}

function npc(world: World, x: number, y: number, slots: { kind: "stack"; prefabId: string; quantity: number }[]): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x, y, z: 0 });
  world.write(id, Inventory, { slots, capacity: 20 });
  return id;
}

function station(world: World, x: number, y: number, capacity = 4, slots: WorkstationBuffer_["slots"] = []): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x, y, z: 0 });
  world.write(id, WorkstationTag, { stationType: "workbench", qualityTier: 1 });
  world.write(id, WorkstationBuffer, { capacity, activeRecipeId: null, slots });
  return id;
}
type WorkstationBuffer_ = { slots: ({ kind: "stack"; itemType: string; quantity: number } | { kind: "unique"; entityId: string; prefabId: string } | null)[] };

Deno.test("transferInputsToBuffer (via place phase): moves inputs from Inventory into WorkstationBuffer", () => {
  const w = new World();
  const wb = station(w, 0, 0);
  const n = npc(w, 0.5, 0, [{ kind: "stack", prefabId: "iron_ore", quantity: 2 }]);

  const action = craftAtWorkbenchJob.tick(input(ctxFor(w, n, 0.5, 0), craftJob({ workbenchId: wb })));
  w.applyChangeset();

  assertEquals(action.replaceJob && (action.replaceJob as Extract<Job, { type: "craftAtWorkbench" }>).phase, "hit");
  assertEquals(w.get(n, Inventory)!.slots, []);
  const bufSlots = w.get(wb, WorkstationBuffer)!.slots;
  assert(bufSlots.some((s) => s?.kind === "stack" && s.itemType === "iron_ore" && s.quantity === 2));
});

Deno.test("place phase: declines (clears job) when the buffer has no room for the inputs", () => {
  const w = new World();
  const wb = station(w, 0, 0, 1, [{ kind: "stack", itemType: "coal", quantity: 1 }]); // capacity 1, already full
  const n = npc(w, 0.5, 0, [{ kind: "stack", prefabId: "iron_ore", quantity: 2 }]);

  const action = craftAtWorkbenchJob.tick(input(ctxFor(w, n, 0.5, 0), craftJob({ workbenchId: wb })));
  w.applyChangeset();

  assertEquals(action.clearJob, true);
  assertEquals(w.get(n, Inventory)!.slots, [{ kind: "stack", prefabId: "iron_ore", quantity: 2 }], "nothing consumed");
  assertEquals(w.get(wb, WorkstationBuffer)!.slots.length, 1, "buffer untouched");
});

Deno.test("T-344: an NPC transfer and a same-tick player LoadWorkstation-style writer on the SAME station both land in the buffer", () => {
  const w = new World();
  const wb = station(w, 0, 0);
  const n = npc(w, 0.5, 0, [{ kind: "stack", prefabId: "iron_ore", quantity: 2 }]);

  // NPC's transfer queues its mutates via tick() (not yet committed)...
  const action = craftAtWorkbenchJob.tick(input(ctxFor(w, n, 0.5, 0), craftJob({ workbenchId: wb })));
  assertEquals(action.replaceJob && (action.replaceJob as Extract<Job, { type: "craftAtWorkbench" }>).phase, "hit");
  // ...simulate a concurrent same-tick writer on the SAME station's buffer
  // (e.g. a player's own LoadWorkstation command), pushed alongside.
  w.mutate(wb, WorkstationBuffer, (cur) => ({
    ...cur,
    slots: [...cur.slots, { kind: "stack" as const, itemType: "coal", quantity: 1 }],
  }));
  w.applyChangeset();

  const bufSlots = w.get(wb, WorkstationBuffer)!.slots;
  assert(bufSlots.some((s) => s?.kind === "stack" && s.itemType === "iron_ore" && s.quantity === 2), "the NPC's transfer landed");
  assert(bufSlots.some((s) => s?.kind === "stack" && s.itemType === "coal" && s.quantity === 1), "the concurrent writer's append also landed — not clobbered");
});
