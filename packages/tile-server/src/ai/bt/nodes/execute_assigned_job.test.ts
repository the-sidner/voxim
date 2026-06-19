/**
 * T-081 — workbench/job-board ownership lifecycle. When the board an NPC is
 * assigned to is destroyed (entity gone), the NPC deauthorises itself: the
 * `execute_assigned_job` node removes its own `AssignedJobBoard` marker and
 * returns failure, so the selector falls through to idle/neutral behaviour.
 *
 * This is the self-healing pull model that supersedes the ticket's original
 * push design (a `WorkbenchOwner` component + `WorkbenchDestroyed` event —
 * neither of which exists): the NPC notices the board is gone on its next tick,
 * however the board vanished (combat, despawn, AoI, reload).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { createBTNodeRegistry, registerBuiltinBTNodes, buildBehaviorTree } from "../mod.ts";
import type { BTContext, BTOutput } from "../mod.ts";
import { JobBoard, AssignedJobBoard } from "../../../components/job_board.ts";
import { WorkstationTag } from "../../../components/building.ts";

const content = await JsonSource.load();
const registry = createBTNodeRegistry();
registerBuiltinBTNodes(registry);

function ctxFor(world: World, entityId: string): BTContext {
  return {
    world, entityId,
    spatial: null as unknown as BTContext["spatial"],
    content,
    currentTick: 0,
    pos: { x: 0, y: 0 },
    tuning: {} as unknown as BTContext["tuning"],
    defaults: content.getGameConfig().npcAiDefaults,
    queue: { current: null, scheduled: [], plan: null },
  } as unknown as BTContext;
}

Deno.test("T-081: NPC deauthorises itself when its assigned board is destroyed", () => {
  const world = new World();
  const npc = newEntityId();
  world.create(npc);
  world.write(npc, AssignedJobBoard, { boardId: "00000000-dead-board-0000-000000000000" });

  const node = buildBehaviorTree({ type: "execute_assigned_job" }, registry);
  const out: BTOutput = {};
  const result = node.tick(ctxFor(world, npc), out);
  world.applyChangeset();

  assertEquals(result, "failure", "no live board → branch fails so idle can take over");
  assert(!world.has(npc, AssignedJobBoard), "the stale assignment is cleared → NPC goes neutral");
});

Deno.test("T-081: an NPC assigned to a live board keeps its assignment", () => {
  const world = new World();
  const board = newEntityId();
  world.create(board);
  world.write(board, WorkstationTag, { stationType: "workbench", qualityTier: 1 });
  world.write(board, JobBoard, { pending: [] });

  const npc = newEntityId();
  world.create(npc);
  world.write(npc, AssignedJobBoard, { boardId: board });

  const node = buildBehaviorTree({ type: "execute_assigned_job" }, registry);
  node.tick(ctxFor(world, npc), {});
  world.applyChangeset();

  assert(world.has(npc, AssignedJobBoard), "a live board keeps the NPC assigned");
});
