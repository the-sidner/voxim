/**
 * T-215 — scene-graph hierarchy invariants.
 *
 * Parent set/get, the reverse child index under reparenting, descendants
 * traversal, subtree teardown through the changeset, transform
 * composition, and the inline Parent codec round-trip.
 */

import { assertEquals } from "jsr:@std/assert";
import { World } from "./world.ts";
import { Parent, composeTransform, IDENTITY_TRANSFORM } from "./scene.ts";
import type { Transform } from "./scene.ts";

function spawn(w: World, id: string): string {
  w.create(id);
  return id;
}

Deno.test("Parent defaults to root; setParent / getParent round-trips", () => {
  const w = new World();
  const a = spawn(w, "a");
  const b = spawn(w, "b");
  assertEquals(w.getParent(b), null);
  assertEquals(Parent.default(), { entityId: null });

  w.setParent(b, a);
  assertEquals(w.getParent(b), "a");
  w.setParent(b, null);
  assertEquals(w.getParent(b), null);
});

Deno.test("child index tracks reparenting", () => {
  const w = new World();
  ["a", "b", "c", "d"].forEach((id) => spawn(w, id));
  w.setParent("b", "a");
  w.setParent("c", "a");
  assertEquals(w.getChildren("a").sort(), ["b", "c"]);

  w.setParent("c", "d"); // reparent
  assertEquals(w.getChildren("a"), ["b"]);
  assertEquals(w.getChildren("d"), ["c"]);
  assertEquals(w.getParent("c"), "d");
});

Deno.test("descendants is depth-first and excludes the root", () => {
  const w = new World();
  ["a", "b", "c", "d"].forEach((id) => spawn(w, id));
  w.setParent("b", "a");
  w.setParent("c", "b"); // a → b → c
  w.setParent("d", "a"); // a → d
  assertEquals(w.descendants("a").sort(), ["b", "c", "d"]);
  assertEquals(w.descendants("c"), []);
});

Deno.test("destroySubtree tombstones the whole subtree, not siblings", () => {
  const w = new World();
  ["a", "b", "c", "d"].forEach((id) => spawn(w, id));
  w.setParent("b", "a");
  w.setParent("c", "b"); // a → b → c
  w.setParent("d", "a"); // a → d (sibling of b)

  w.destroySubtree("b");
  // Deferred until applyChangeset.
  assertEquals(w.isAlive("b"), false); // tombstoned immediately
  w.applyChangeset();

  assertEquals(w.isAlive("a"), true);
  assertEquals(w.isAlive("d"), true);
  assertEquals(w.isAlive("b"), false);
  assertEquals(w.isAlive("c"), false);
  // Index cleaned: b no longer a child of a.
  assertEquals(w.getChildren("a"), ["d"]);
  assertEquals(w.getChildren("b"), []);
});

Deno.test("worldTransform composes translation + scale up the chain", () => {
  const w = new World();
  ["root", "mid", "leaf"].forEach((id) => spawn(w, id));
  w.setParent("mid", "root");
  w.setParent("leaf", "mid");

  const locals: Record<string, Transform> = {
    root: { x: 10, y: 0, z: 0, scale: 2 },
    mid: { x: 1, y: 0, z: 0, scale: 3 },
    leaf: { x: 1, y: 0, z: 0, scale: 1 },
  };
  const localOf = (id: string) => locals[id];

  // root world = its local (no parent).
  assertEquals(w.worldTransform("root", localOf), { x: 10, y: 0, z: 0, scale: 2 });
  // mid = root ∘ mid: x = 10 + 1*2 = 12, scale = 2*3 = 6.
  assertEquals(w.worldTransform("mid", localOf), { x: 12, y: 0, z: 0, scale: 6 });
  // leaf = mid ∘ leaf: x = 12 + 1*6 = 18, scale = 6*1 = 6.
  assertEquals(w.worldTransform("leaf", localOf), { x: 18, y: 0, z: 0, scale: 6 });
  // localTransform is the entity's own.
  assertEquals(w.localTransform("mid", localOf), { x: 1, y: 0, z: 0, scale: 3 });
});

Deno.test("worldTransform terminates on a parent cycle and missing locals fall back to identity", () => {
  const w = new World();
  spawn(w, "x");
  spawn(w, "y");
  w.setParent("x", "y");
  w.setParent("y", "x"); // cycle
  // No infinite loop; no local transforms supplied → identity.
  assertEquals(w.worldTransform("x", () => undefined), IDENTITY_TRANSFORM);
});

Deno.test("composeTransform: parent ∘ local", () => {
  const p: Transform = { x: 5, y: 5, z: 0, scale: 2 };
  const l: Transform = { x: 2, y: 0, z: 1, scale: 4 };
  assertEquals(composeTransform(p, l), { x: 9, y: 5, z: 2, scale: 8 });
});

Deno.test("Parent codec round-trips a parent id and root", () => {
  const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  assertEquals(Parent.codec.decode(Parent.codec.encode({ entityId: id })), { entityId: id });
  assertEquals(Parent.codec.decode(Parent.codec.encode({ entityId: null })), { entityId: null });
});
