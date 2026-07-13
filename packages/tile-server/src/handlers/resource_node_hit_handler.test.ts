/**
 * T-333 — the concrete break the ticket names: once a tree's trunk becomes a
 * child entity, the struck geometry (Hitbox, on the trunk) and the harvest
 * behaviour (ResourceNode, on the tree's logical root) live on different
 * entities. Before T-333, `ResourceNodeHitHandler.onHit` required
 * `ctx.targetId` ITSELF to carry `ResourceNode` — a hit landing on the trunk
 * child would silently no-op, making the tree unharvestable. These tests go
 * through the real dispatch tail (`dispatchSweepHit`) with the real handler,
 * using real content (`tree.json`'s authored ResourceNode data), so they
 * prove the fix at the same layer the bug would have hit.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId, EventBus, type EntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import type { HitContext } from "../hit_handler.ts";
import { Position } from "../components/game.ts";
import { Hitbox } from "../components/hitbox.ts";
import type { HitboxData } from "../components/hitbox.ts";
import { ResourceNode } from "../components/resource_node.ts";
import { dispatchSweepHit } from "../combat/sweep.ts";
import { ResourceNodeHitHandler } from "./resource_node_hit_handler.ts";

const content = await JsonSource.load();

const TRUNK_HITBOX: HitboxData = {
  derive: false,
  parts: [{ id: "trunk", fromFwd: 0, fromRight: 0, fromUp: 0, toFwd: 0, toRight: 0, toUp: 1, radius: 0.5 }],
};
const SEGMENTS = [{ from: { x: 0, y: 0, z: 0.5 }, to: { x: 0, y: 0, z: 0.5 } }]; // sits inside the capsule

function axeContext(struckId: EntityId, attackerId: EntityId) {
  return (hit: { partId: string }): HitContext => ({
    attackerId,
    targetId: struckId,
    weaponStats: { weight: 1, toolType: "axe", harvestPower: 2 },
    bodyPart: hit.partId,
    attackerPart: "mid",
    targetSnapshotFacing: 0,
    attackerX: 0, attackerY: 0,
    targetX: 0, targetY: 0,
    hitX: 0, hitY: 0, hitZ: 0.5,
    parryAllowed: true,
  });
}

Deno.test("ResourceNodeHitHandler: a parentless node is harvested directly (behaviour-preserving)", () => {
  const w = new World();
  const events = new EventBus();
  const attacker = newEntityId();
  w.create(attacker);
  const node = newEntityId();
  w.create(node);
  w.write(node, Position, { x: 0, y: 0, z: 0 });
  w.write(node, Hitbox, TRUNK_HITBOX);
  w.write(node, ResourceNode, { nodeTypeId: "tree", hitPoints: 5, depleted: false });

  const handler = new ResourceNodeHitHandler(content);
  const hit = dispatchSweepHit(
    w, events, [handler], TRUNK_HITBOX, { x: 0, y: 0, z: 0 }, 0, 0.1, SEGMENTS, axeContext(node, attacker),
  );

  assert(hit !== null);
  w.applyChangeset(); // handler writes are deferred (world.set) until commit
  assertEquals(w.get(node, ResourceNode)?.hitPoints, 3); // 5 - harvestPower(2)
});

Deno.test("ResourceNodeHitHandler: a hit on the trunk CHILD bubbles to the tree ROOT's ResourceNode", () => {
  const w = new World();
  const events = new EventBus();
  const attacker = newEntityId();
  w.create(attacker);

  // The tree's logical root carries the behaviour — no Hitbox of its own.
  const treeRoot = newEntityId();
  w.create(treeRoot);
  w.write(treeRoot, ResourceNode, { nodeTypeId: "tree", hitPoints: 5, depleted: false });

  // The trunk is a scene-graph CHILD carrying the struck geometry.
  const trunk = newEntityId();
  w.create(trunk);
  w.write(trunk, Position, { x: 0, y: 0, z: 0 });
  w.write(trunk, Hitbox, TRUNK_HITBOX);
  w.setParent(trunk, treeRoot);

  const handler = new ResourceNodeHitHandler(content);
  const hit = dispatchSweepHit(
    w, events, [handler], TRUNK_HITBOX, { x: 0, y: 0, z: 0 }, 0, 0.1, SEGMENTS, axeContext(trunk, attacker),
  );

  assert(hit !== null, "expected the fixed geometry to intersect the trunk's hitbox");
  w.applyChangeset(); // handler writes are deferred (world.set) until commit
  // Pre-T-333 this would be a silent no-op: the handler checked
  // world.get(ctx.targetId=trunk, ResourceNode) and found nothing.
  assertEquals(w.get(treeRoot, ResourceNode)?.hitPoints, 3, "tree root's ResourceNode took the harvest hit");
  assertEquals(w.get(trunk, ResourceNode), null, "the trunk child never carried ResourceNode itself");
});
