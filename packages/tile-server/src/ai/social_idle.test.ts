/**
 * Social idle clustering (T-043): an idle, mobile NPC drifts toward a nearby
 * fellow so idle NPCs gather rather than mill at random; stationary NPCs
 * (wanderRadius 0) never leave to socialise.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { NpcTag } from "../components/npcs.ts";
import { Position, Health } from "../components/game.ts";
import { SpatialGrid } from "../spatial_grid.ts";
import { findNearestNpc } from "./plan_helpers.ts";
import { createBTNodeRegistry, registerBuiltinBTNodes, buildBehaviorTree } from "./bt/mod.ts";
import type { BTContext, BTOutput } from "./bt/mod.ts";

const registry = createBTNodeRegistry();
registerBuiltinBTNodes(registry);

function npc(w: World, x: number, y: number): string {
  const id = newEntityId();
  w.create(id);
  w.write(id, Position, { x, y, z: 0 });
  w.write(id, NpcTag, NpcTag.default());
  return id;
}

// ── findNearestNpc ──
Deno.test("findNearestNpc: nearest fellow, excluding self and non-NPCs", () => {
  const w = new World();
  const me = npc(w, 100, 100);
  const near = npc(w, 104, 100);  // 4u
  npc(w, 110, 100);               // 10u (farther)
  // a player (no NpcTag) right next to me must be ignored
  const player = newEntityId();
  w.create(player);
  w.write(player, Position, { x: 101, y: 100, z: 0 });
  w.write(player, Health, { current: 100, max: 100 });

  const grid = new SpatialGrid();
  grid.rebuild(w);
  assertEquals(findNearestNpc(grid, w, me, 100, 100, 12 * 12), near);
});

Deno.test("findNearestNpc: nothing within radius → null", () => {
  const w = new World();
  const me = npc(w, 100, 100);
  npc(w, 130, 100); // 30u away, outside a 12u scan
  const grid = new SpatialGrid();
  grid.rebuild(w);
  assertEquals(findNearestNpc(grid, w, me, 100, 100, 12 * 12), null);
});

// ── the node ──
function ctxFor(w: World, id: string, x: number, y: number, wanderRadius: number, socialChance: number): BTContext {
  return {
    world: w, entityId: id, pos: { x, y },
    spatial: (() => { const g = new SpatialGrid(); g.rebuild(w); return g; })(),
    content: null as unknown as BTContext["content"],
    currentTick: 0,
    tuning: { wanderRadius, idleTicks: 40, wanderTicks: 60 } as unknown as BTContext["tuning"],
    defaults: { socialIdleChance: socialChance, socialScanRadius: 12 } as unknown as BTContext["defaults"],
  } as unknown as BTContext;
}

Deno.test("set_job_default: a mobile idle NPC drifts toward a nearby fellow (chance forced)", () => {
  const w = new World();
  const me = npc(w, 100, 100);
  const friend = npc(w, 106, 100); // 6u east, within the 12u social radius
  void friend;

  const node = buildBehaviorTree({ type: "set_job_default" }, registry);
  const out: BTOutput = {};
  node.tick(ctxFor(w, me, 100, 100, /*wanderRadius*/ 10, /*socialChance*/ 1), out);

  assertEquals(out.replaceCurrent?.type, "wander");
  const job = out.replaceCurrent as { type: "wander"; targetX: number; targetY: number };
  // Heads toward the friend, stopping ~1.5u short (lands near x≈104.5, not at 106).
  assert(job.targetX > 100 && job.targetX < 106, `target ${job.targetX} should be between self and friend`);
  assertEquals(Math.round(job.targetY), 100);
});

Deno.test("set_job_default: a stationary NPC (wanderRadius 0) never leaves to socialise", () => {
  const w = new World();
  const me = npc(w, 100, 100);
  npc(w, 106, 100); // friend right there, but we're a stall-keeper

  const node = buildBehaviorTree({ type: "set_job_default" }, registry);
  for (let i = 0; i < 30; i++) {
    const out: BTOutput = {};
    node.tick(ctxFor(w, me, 100, 100, /*wanderRadius*/ 0, /*socialChance*/ 1), out);
    if (out.replaceCurrent?.type === "wander") {
      const job = out.replaceCurrent as { targetX: number; targetY: number };
      // wanderRadius 0 → target is our own spot; never drifts toward the friend.
      assertEquals(Math.round(job.targetX), 100, "stationary NPC stays put");
    }
  }
});
