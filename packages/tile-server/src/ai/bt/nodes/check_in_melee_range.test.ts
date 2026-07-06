/**
 * check_in_melee_range (T-299) — success only when the NPC's current job is
 * attackTarget AND the target is within `tuning.attackRangeSq`.
 */
import { assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { createBTNodeRegistry, registerBuiltinBTNodes, buildBehaviorTree } from "../mod.ts";
import type { BTContext } from "../mod.ts";
import { Position } from "../../../components/game.ts";

const content = await JsonSource.load();
const registry = createBTNodeRegistry();
registerBuiltinBTNodes(registry);
const ATTACK_RANGE_SQ = 4; // range 2

function ctxFor(world: World, entityId: string, job: BTContext["queue"]["current"]): BTContext {
  return {
    world, entityId,
    spatial: null as unknown as BTContext["spatial"],
    content,
    currentTick: 0,
    pos: { x: 0, y: 0 },
    tuning: { attackRangeSq: ATTACK_RANGE_SQ } as unknown as BTContext["tuning"],
    defaults: content.getGameConfig().npcAiDefaults,
    queue: { current: job, scheduled: [], plan: null },
  } as unknown as BTContext;
}

Deno.test("check_in_melee_range: fails when there is no current job", () => {
  const world = new World();
  const npc = newEntityId();
  world.create(npc);
  const node = buildBehaviorTree({ type: "check_in_melee_range" }, registry);
  assertEquals(node.tick(ctxFor(world, npc, null), {}), "failure");
});

Deno.test("check_in_melee_range: fails when the current job is not attackTarget", () => {
  const world = new World();
  const npc = newEntityId();
  world.create(npc);
  const node = buildBehaviorTree({ type: "check_in_melee_range" }, registry);
  const job = { type: "wander" as const, targetX: 0, targetY: 0, expiresAt: 100 };
  assertEquals(node.tick(ctxFor(world, npc, job), {}), "failure");
});

Deno.test("check_in_melee_range: succeeds when the attackTarget is within attackRangeSq", () => {
  const world = new World();
  const npc = newEntityId();
  const target = newEntityId();
  world.create(npc);
  world.create(target);
  world.write(target, Position, { x: 1.5, y: 0, z: 0 }); // distSq = 2.25 < 4
  const node = buildBehaviorTree({ type: "check_in_melee_range" }, registry);
  const job = { type: "attackTarget" as const, targetId: target, expiresAt: 100 };
  assertEquals(node.tick(ctxFor(world, npc, job), {}), "success");
});

Deno.test("check_in_melee_range: fails when the attackTarget is beyond attackRangeSq", () => {
  const world = new World();
  const npc = newEntityId();
  const target = newEntityId();
  world.create(npc);
  world.create(target);
  world.write(target, Position, { x: 10, y: 0, z: 0 }); // distSq = 100 > 4
  const node = buildBehaviorTree({ type: "check_in_melee_range" }, registry);
  const job = { type: "attackTarget" as const, targetId: target, expiresAt: 100 };
  assertEquals(node.tick(ctxFor(world, npc, job), {}), "failure");
});

Deno.test("check_in_melee_range: fails when the target entity has no Position", () => {
  const world = new World();
  const npc = newEntityId();
  const target = newEntityId();
  world.create(npc);
  world.create(target); // no Position written
  const node = buildBehaviorTree({ type: "check_in_melee_range" }, registry);
  const job = { type: "attackTarget" as const, targetId: target, expiresAt: 100 };
  assertEquals(node.tick(ctxFor(world, npc, job), {}), "failure");
});
