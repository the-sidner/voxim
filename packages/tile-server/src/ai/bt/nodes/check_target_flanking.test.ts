/**
 * check_target_flanking (T-299) — success when the NPC's current
 * attackTarget sits outside the NPC's own frontal block arc
 * (`combat.blockArcHalfRadians`).
 */
import { assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { createBTNodeRegistry, registerBuiltinBTNodes, buildBehaviorTree } from "../mod.ts";
import type { BTContext } from "../mod.ts";
import { Facing, Position } from "../../../components/game.ts";

const content = await JsonSource.load();
const registry = createBTNodeRegistry();
registerBuiltinBTNodes(registry);
const HALF_ARC = content.getGameConfig().combat.blockArcHalfRadians; // PI/2 in real content

function ctxFor(world: World, entityId: string, job: BTContext["queue"]["current"]): BTContext {
  return {
    world, entityId,
    spatial: null as unknown as BTContext["spatial"],
    content,
    currentTick: 0,
    pos: { x: 0, y: 0 },
    tuning: {} as unknown as BTContext["tuning"],
    defaults: content.getGameConfig().npcAiDefaults,
    queue: { current: job, scheduled: [], plan: null },
  } as unknown as BTContext;
}

function attackJob(targetId: string) {
  return { type: "attackTarget" as const, targetId, expiresAt: 100 };
}

Deno.test("check_target_flanking: fails when there is no attackTarget job", () => {
  const world = new World();
  const npc = newEntityId();
  world.create(npc);
  const node = buildBehaviorTree({ type: "check_target_flanking" }, registry);
  assertEquals(node.tick(ctxFor(world, npc, null), {}), "failure");
});

Deno.test("check_target_flanking: fails when the target is directly in front (facing straight at it)", () => {
  const world = new World();
  const npc = newEntityId();
  const target = newEntityId();
  world.create(npc);
  world.create(target);
  world.write(npc, Facing, { angle: 0 });
  world.write(target, Position, { x: 5, y: 0, z: 0 }); // dead ahead of facing=0
  const node = buildBehaviorTree({ type: "check_target_flanking" }, registry);
  assertEquals(node.tick(ctxFor(world, npc, attackJob(target)), {}), "failure");
});

Deno.test("check_target_flanking: succeeds when the target is directly behind (outside the block arc)", () => {
  const world = new World();
  const npc = newEntityId();
  const target = newEntityId();
  world.create(npc);
  world.create(target);
  world.write(npc, Facing, { angle: 0 });
  world.write(target, Position, { x: -5, y: 0, z: 0 }); // directly behind facing=0
  const node = buildBehaviorTree({ type: "check_target_flanking" }, registry);
  assertEquals(node.tick(ctxFor(world, npc, attackJob(target)), {}), "success");
});

Deno.test("check_target_flanking: at exactly the block arc boundary counts as still faced (not flanking)", () => {
  const world = new World();
  const npc = newEntityId();
  const target = newEntityId();
  world.create(npc);
  world.create(target);
  world.write(npc, Facing, { angle: 0 });
  // Exactly at the block arc's edge (90° off, matching blockArcHalfRadians=PI/2).
  world.write(target, Position, { x: 0, y: 5, z: 0 });
  const node = buildBehaviorTree({ type: "check_target_flanking" }, registry);
  assertEquals(node.tick(ctxFor(world, npc, attackJob(target)), {}), "failure",
    `angle exactly == halfArc (${HALF_ARC.toFixed(4)}) is not "> halfArc"`);
});

Deno.test("check_target_flanking: fails when target and NPC are at the same position (degenerate)", () => {
  const world = new World();
  const npc = newEntityId();
  const target = newEntityId();
  world.create(npc);
  world.create(target);
  world.write(npc, Facing, { angle: 0 });
  world.write(target, Position, { x: 0, y: 0, z: 0 });
  const node = buildBehaviorTree({ type: "check_target_flanking" }, registry);
  assertEquals(node.tick(ctxFor(world, npc, attackJob(target)), {}), "failure");
});
