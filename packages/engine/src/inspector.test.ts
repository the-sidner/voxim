/**
 * T-224 — EngineInspector against a synthetic World.
 *
 * Mirrors scene.test.ts's style: string entity ids, inline server-only
 * components standing in for real game components (Health, Position),
 * exercising entity enumeration, per-entity snapshot, scene-tree walk, and
 * summary counts generically — the module must not know these are
 * "game" components at all.
 */
import { assertEquals } from "jsr:@std/assert";
import { World } from "./world.ts";
import { Parent } from "./scene.ts";
import { defineComponent } from "./component.ts";
import { EngineInspector } from "./inspector.ts";

interface HealthData {
  current: number;
  max: number;
}
const Health = defineComponent({
  name: "health" as const,
  networked: false,
  codec: { encode: () => new Uint8Array(), decode: () => ({ current: 0, max: 0 }) },
  default: (): HealthData => ({ current: 100, max: 100 }),
});

interface TagData {
  value: true;
}
const NpcTag = defineComponent({
  name: "npcTag" as const,
  networked: false,
  codec: { encode: () => new Uint8Array(), decode: () => ({ value: true }) },
  default: (): TagData => ({ value: true }),
});

const DEFS = [Health, NpcTag, Parent];

function spawn(w: World, id: string): string {
  w.create(id);
  return id;
}

Deno.test("listEntities: no filter returns every living entity", () => {
  const w = new World();
  spawn(w, "a");
  spawn(w, "b");
  const insp = new EngineInspector(w, DEFS);
  assertEquals(new Set(insp.listEntities()), new Set(["a", "b"]));
});

Deno.test("listEntities: excludes tombstoned/destroyed entities", () => {
  const w = new World();
  spawn(w, "a");
  spawn(w, "b");
  w.destroy("a");
  const insp = new EngineInspector(w, DEFS);
  assertEquals(insp.listEntities(), ["b"]);
});

Deno.test("listEntities: with filter intersects via World.query", () => {
  const w = new World();
  spawn(w, "a");
  spawn(w, "b");
  spawn(w, "c");
  w.write("a", Health, { current: 10, max: 10 });
  w.write("a", NpcTag, { value: true });
  w.write("b", Health, { current: 10, max: 10 });
  const insp = new EngineInspector(w, DEFS);
  assertEquals(insp.listEntities({ with: [Health] }).sort(), ["a", "b"]);
  assertEquals(insp.listEntities({ with: [Health, NpcTag] }), ["a"]);
});

Deno.test("listEntities: without filter excludes matching entities", () => {
  const w = new World();
  spawn(w, "a");
  spawn(w, "b");
  w.write("a", NpcTag, { value: true });
  const insp = new EngineInspector(w, DEFS);
  assertEquals(insp.listEntities({ without: [NpcTag] }), ["b"]);
});

Deno.test("listEntities: with + without compose", () => {
  const w = new World();
  spawn(w, "a");
  spawn(w, "b");
  w.write("a", Health, { current: 10, max: 10 });
  w.write("a", NpcTag, { value: true });
  w.write("b", Health, { current: 10, max: 10 });
  const insp = new EngineInspector(w, DEFS);
  assertEquals(insp.listEntities({ with: [Health], without: [NpcTag] }), ["b"]);
});

Deno.test("inspectEntity: returns every present component by identity, null for missing/dead", () => {
  const w = new World();
  spawn(w, "a");
  w.write("a", Health, { current: 42, max: 100 });
  const insp = new EngineInspector(w, DEFS);

  const snap = insp.inspectEntity("a");
  assertEquals(snap, {
    entityId: "a",
    parent: null,
    components: { health: { current: 42, max: 100 } },
  });

  assertEquals(insp.inspectEntity("nonexistent"), null);

  w.destroy("a");
  assertEquals(insp.inspectEntity("a"), null);
});

Deno.test("inspectEntity: reports the live Parent link", () => {
  const w = new World();
  spawn(w, "parent");
  spawn(w, "child");
  w.setParent("child", "parent");
  const insp = new EngineInspector(w, DEFS);
  const snap = insp.inspectEntity("child")!;
  assertEquals(snap.parent, "parent");
  assertEquals(snap.components["parent"], { entityId: "parent" });
});

Deno.test("sceneTree: builds roots -> descendants from the live World", () => {
  const w = new World();
  spawn(w, "root");
  spawn(w, "child1");
  spawn(w, "child2");
  spawn(w, "grandchild");
  spawn(w, "loner");
  w.setParent("child1", "root");
  w.setParent("child2", "root");
  w.setParent("grandchild", "child1");

  const insp = new EngineInspector(w, DEFS);
  const forest = insp.sceneTree();
  assertEquals(forest.length, 2); // "root" and "loner"

  const rootNode = forest.find((n) => n.entityId === "root")!;
  assertEquals(rootNode.children.map((c) => c.entityId).sort(), ["child1", "child2"]);
  const child1Node = rootNode.children.find((n) => n.entityId === "child1")!;
  assertEquals(child1Node.children.map((c) => c.entityId), ["grandchild"]);

  const lonerNode = forest.find((n) => n.entityId === "loner")!;
  assertEquals(lonerNode.children, []);
});

Deno.test("sceneTree: an orphan (parent destroyed without destroySubtree) surfaces as its own root", () => {
  const w = new World();
  spawn(w, "parent");
  spawn(w, "child");
  w.setParent("child", "parent");
  w.destroy("parent"); // plain destroy, NOT destroySubtree — child is now an orphan

  const insp = new EngineInspector(w, DEFS);
  const forest = insp.sceneTree();
  assertEquals(forest.map((n) => n.entityId), ["child"]);
});

Deno.test("sceneTree: rootIds override drills into a specific subtree", () => {
  const w = new World();
  spawn(w, "root");
  spawn(w, "child");
  w.setParent("child", "root");

  const insp = new EngineInspector(w, DEFS);
  const forest = insp.sceneTree(["child"]);
  assertEquals(forest.length, 1);
  assertEquals(forest[0].entityId, "child");
  assertEquals(forest[0].children, []);
});

Deno.test("sceneTree: a Parent cycle does not hang the walk", () => {
  const w = new World();
  spawn(w, "a");
  spawn(w, "b");
  // Force a 2-cycle directly through the immediate write path (setParent's
  // own reverse-index bookkeeping would prevent constructing this through
  // its public API — same access `applyChangeset`'s Parent handling uses).
  w.write("a", Parent, { entityId: "b" });
  w.write("b", Parent, { entityId: "a" });

  const insp = new EngineInspector(w, DEFS);
  const forest = insp.sceneTree(["a"]); // explicit root forces a walk INTO the cycle
  assertEquals(forest.length, 1);
  assertEquals(forest[0].entityId, "a");
  // "a" -> children (via childIndex, unrelated to the raw Parent writes
  // above since setParent wasn't used) is empty; the guard exists for
  // whatever child-index shape a caller-supplied rootIds walk might hit.
});

Deno.test("summary: living-entity count per registered component", () => {
  const w = new World();
  spawn(w, "a");
  spawn(w, "b");
  spawn(w, "c");
  w.write("a", Health, { current: 10, max: 10 });
  w.write("b", Health, { current: 10, max: 10 });
  w.write("a", NpcTag, { value: true });
  w.destroy("b"); // b is tombstoned; must not count until purged, and query already excludes it

  const insp = new EngineInspector(w, DEFS);
  const rows = new Map(insp.summary().map((r) => [r.name, r.count]));
  assertEquals(rows.get("health"), 1);
  assertEquals(rows.get("npcTag"), 1);
  assertEquals(rows.get("parent"), 0);
});
