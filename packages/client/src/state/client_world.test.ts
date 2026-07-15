/**
 * T-223 — ClientWorld's parent→children reverse index (childrenOf/
 * descendants). First dedicated test file for this module. Pure data, no
 * THREE dependency — everything here goes through the real wire-decode path
 * (applySpawn/applyDelta/applyRemoval/applyDestroy), not a synthetic
 * shortcut, so it pins the actual decode-side behavior a renderer depends on.
 */
import { assertEquals } from "jsr:@std/assert";
import { ComponentType } from "@voxim/protocol";
import { Parent } from "@voxim/engine";
import { ClientWorld } from "./client_world.ts";
import type { BinaryEntitySpawn, BinaryComponentDelta } from "@voxim/protocol";

function parentSpawn(entityId: string, parentId: string | null): BinaryEntitySpawn {
  return {
    entityId,
    components: [
      { componentType: ComponentType.parent, data: Parent.codec.encode({ entityId: parentId }) },
    ],
  };
}

function parentDelta(entityId: string, parentId: string | null, version: number): BinaryComponentDelta {
  return {
    entityId,
    componentType: ComponentType.parent,
    version,
    data: Parent.codec.encode({ entityId: parentId }),
  };
}

Deno.test("ClientWorld: spawn with a parent component populates childrenOf(parent)", () => {
  const w = new ClientWorld();
  w.applySpawn(parentSpawn("child", "root"));
  assertEquals(w.childrenOf("root"), ["child"]);
  assertEquals(w.get("child")?.parent, { entityId: "root" });
});

Deno.test("ClientWorld: a delta changing an entity's parent moves it from the old bucket to the new one", () => {
  const w = new ClientWorld();
  w.applySpawn(parentSpawn("item", "handA"));
  assertEquals(w.childrenOf("handA"), ["item"]);
  assertEquals(w.childrenOf("handB"), []);

  w.applyDelta(parentDelta("item", "handB", 1));
  assertEquals(w.childrenOf("handA"), [], "old bucket emptied (and pruned)");
  assertEquals(w.childrenOf("handB"), ["item"]);
  assertEquals(w.get("item")?.parent, { entityId: "handB" });
});

Deno.test("ClientWorld: a stale (same/older version) delta is discarded and does not disturb the index", () => {
  const w = new ClientWorld();
  w.applySpawn(parentSpawn("item", "handA"));
  w.applyDelta(parentDelta("item", "handB", 5));
  assertEquals(w.childrenOf("handB"), ["item"]);

  // Stale — version 5 was already applied; version 3 must be ignored.
  w.applyDelta(parentDelta("item", "handA", 3));
  assertEquals(w.childrenOf("handB"), ["item"], "stale delta must not move the child back");
  assertEquals(w.childrenOf("handA"), []);
});

Deno.test("ClientWorld: destroying a child removes it from its parent's bucket", () => {
  const w = new ClientWorld();
  w.applySpawn(parentSpawn("child", "root"));
  assertEquals(w.childrenOf("root"), ["child"]);
  w.applyDestroy("child");
  assertEquals(w.childrenOf("root"), []);
  assertEquals(w.has("child"), false);
});

Deno.test("ClientWorld: destroying a parent clears its own outbound bucket; a since-orphaned child stays independently destroyable", () => {
  const w = new ClientWorld();
  w.applySpawn(parentSpawn("child", "root"));
  w.applyDestroy("root"); // parent entity destroyed first — child's own destroy is a separate, later message
  assertEquals(w.childrenOf("root"), [], "root's bucket is gone regardless of who destroys first");
  // Child is still independently trackable (still parented to "root" in its
  // own EntityState) until ITS destroy message arrives — descendants() of
  // an id no longer in `entities` still walks the index defensively.
  assertEquals(w.childrenOf("root"), []);
  w.applyDestroy("child");
  assertEquals(w.has("child"), false);
});

Deno.test("ClientWorld: descendants() returns a 3-level chain in parent-before-child order", () => {
  const w = new ClientWorld();
  w.applySpawn(parentSpawn("a", "root"));
  w.applySpawn(parentSpawn("b", "a"));
  w.applySpawn(parentSpawn("c", "b"));
  assertEquals(w.descendants("root"), ["a", "b", "c"]);
});

Deno.test("ClientWorld: descendants() branches correctly (parent-before-child holds per branch)", () => {
  const w = new ClientWorld();
  w.applySpawn(parentSpawn("armL", "root"));
  w.applySpawn(parentSpawn("handL", "armL"));
  w.applySpawn(parentSpawn("armR", "root"));
  w.applySpawn(parentSpawn("handR", "armR"));
  const all = w.descendants("root");
  assertEquals(all.length, 4);
  assertEquals(all.indexOf("armL") < all.indexOf("handL"), true);
  assertEquals(all.indexOf("armR") < all.indexOf("handR"), true);
});

Deno.test("ClientWorld: childrenOf() on a parent id that was never itself spawned still returns the child (defensive indexing)", () => {
  const w = new ClientWorld();
  // "root" is never spawned — only "child" arrives, declaring a parent that
  // hasn't (or never will) show up. Mirrors the honest AoI case: a parent
  // that already left visibility range.
  w.applySpawn(parentSpawn("child", "root"));
  assertEquals(w.has("root"), false);
  assertEquals(w.childrenOf("root"), ["child"]);
});

Deno.test("ClientWorld: applyRemoval of a parent component reverts the entity to root and clears the old bucket", () => {
  const w = new ClientWorld();
  w.applySpawn(parentSpawn("item", "handA"));
  assertEquals(w.childrenOf("handA"), ["item"]);
  w.applyRemoval("item", ComponentType.parent);
  assertEquals(w.childrenOf("handA"), []);
  assertEquals(w.get("item")?.parent, undefined);
});

Deno.test("ClientWorld: clear() empties the index", () => {
  const w = new ClientWorld();
  w.applySpawn(parentSpawn("child", "root"));
  assertEquals(w.childrenOf("root"), ["child"]);
  w.clear();
  assertEquals(w.childrenOf("root"), []);
  assertEquals(w.has("child"), false);
});

Deno.test("ClientWorld: clear() re-arms the snapshot staleness guard (tile transition to a younger server)", () => {
  const w = new ClientWorld();
  const ent = (x: number) => ({ entityId: "e1", x, y: 0, z: 0, facing: 0, vx: 0, vy: 0, vz: 0 });

  // Long-running old tile: snapshot at a high tick latches the guard.
  w.applySpawn({ entityId: "e1", components: [] });
  w.applySnapshot({ serverTick: 500_000, entities: [ent(1)] });
  assertEquals(w.get("e1")?.position?.x, 1);

  // Tile transition: clear(), then the freshly booted destination sends
  // snapshots with much lower ticks — they must be accepted, not discarded.
  w.clear();
  w.applySpawn({ entityId: "e1", components: [] });
  w.applySnapshot({ serverTick: 2_000, entities: [ent(7)] });
  assertEquals(w.get("e1")?.position?.x, 7, "post-clear snapshot from a younger server must apply");
});

Deno.test("ClientWorld: reparenting away from null (initial spawn with no parent) is a no-op for the index", () => {
  const w = new ClientWorld();
  w.applySpawn({ entityId: "loner", components: [] });
  assertEquals(w.get("loner")?.parent, undefined);
  assertEquals(w.childrenOf("loner"), []);
});
