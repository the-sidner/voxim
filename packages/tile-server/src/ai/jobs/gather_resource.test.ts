/**
 * GatherResource drop-collection (T-144): once the node is depleted the
 * forester sweeps the settled ItemData drops it ejected into its own
 * inventory, ignoring still-in-flight (Velocity) drops, and prioritises
 * chopping a live node over collecting.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { ACTION_USE_SKILL } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import { Position, Velocity } from "../../components/game.ts";
import { Inventory, ItemData } from "../../components/items.ts";
import { ResourceNode } from "../../components/resource_node.ts";
import { gatherResourceJob } from "./gather_resource.ts";
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

function gatherJob(over: Partial<Extract<Job, { type: "gatherResource" }>> = {}): Job {
  return {
    type: "gatherResource",
    itemType: "oak_wood",
    targetQuantity: 5,
    nodeId: null,
    resourceNodeTypes: ["birch_tree"],
    expiresAt: 100,
    ...over,
  };
}

function input(ctx: JobContext, job: Job): JobTickInput {
  return { ctx, job, plan: null, planDirX: 0, planDirY: 0 };
}

Deno.test("gatherResource: collects a settled drop into inventory when no live node remains", () => {
  const w = new World();
  const npc = newEntityId();
  w.create(npc);
  w.write(npc, Position, { x: 0, y: 0, z: 0 });
  w.write(npc, Inventory, { slots: [], capacity: 20 });

  const drop = newEntityId();
  w.create(drop);
  w.write(drop, Position, { x: 1, y: 0, z: 0 }); // within pickupRadius
  w.write(drop, ItemData, { prefabId: "oak_wood", quantity: 3 });

  const action = gatherResourceJob.tick(input(ctxFor(w, npc, 0, 0), gatherJob()));
  w.applyChangeset();

  assertEquals(action.actions, 0); // not chopping — collecting
  assertEquals(w.get(npc, Inventory)!.slots, [{ kind: "stack", prefabId: "oak_wood", quantity: 3 }]);
  assert(!w.isAlive(drop), "drop entity destroyed after pickup");
});

Deno.test("gatherResource: ignores a still-in-flight (Velocity) drop", () => {
  const w = new World();
  const npc = newEntityId();
  w.create(npc);
  w.write(npc, Position, { x: 0, y: 0, z: 0 });
  w.write(npc, Inventory, { slots: [], capacity: 20 });

  const flying = newEntityId();
  w.create(flying);
  w.write(flying, Position, { x: 1, y: 0, z: 0 });
  w.write(flying, ItemData, { prefabId: "oak_wood", quantity: 3 });
  w.write(flying, Velocity, { x: 0, y: 0, z: 2 }); // ejecting — not settled

  const action = gatherResourceJob.tick(input(ctxFor(w, npc, 0, 0), gatherJob()));
  w.applyChangeset();

  // No settled drop, no live node → clears the job; the flying drop survives.
  assertEquals(action.clearJob, true);
  assertEquals(w.get(npc, Inventory)!.slots, []);
  assert(w.isAlive(flying), "in-flight drop is left to settle");
});

Deno.test("gatherResource: a live node in range is chopped, not bypassed for drops", () => {
  const w = new World();
  const npc = newEntityId();
  w.create(npc);
  w.write(npc, Position, { x: 0, y: 0, z: 0 });
  w.write(npc, Inventory, { slots: [], capacity: 20 });

  const node = newEntityId();
  w.create(node);
  w.write(node, Position, { x: 1, y: 0, z: 0 });
  w.write(node, ResourceNode, { nodeTypeId: "birch_tree", hitPoints: 5, depleted: false });

  // A settled drop also sits here — the live node must win.
  const drop = newEntityId();
  w.create(drop);
  w.write(drop, Position, { x: 1, y: 0, z: 0 });
  w.write(drop, ItemData, { prefabId: "oak_wood", quantity: 1 });

  // First tick binds the node (replaceJob); second tick chops it.
  const bind = gatherResourceJob.tick(input(ctxFor(w, npc, 0, 0), gatherJob()));
  assertEquals(bind.replaceJob?.type, "gatherResource");
  assertEquals((bind.replaceJob as Extract<Job, { type: "gatherResource" }>).nodeId, node);

  const chop = gatherResourceJob.tick(input(ctxFor(w, npc, 0, 0), gatherJob({ nodeId: node })));
  assertEquals(chop.actions, ACTION_USE_SKILL);
  assert(w.isAlive(drop), "drop is left until the node is depleted");
});
