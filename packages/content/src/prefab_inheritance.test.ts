import { assertEquals, assertThrows } from "jsr:@std/assert";
import { resolvePrefabInheritance } from "./loader.ts";
import type { Prefab } from "./types.ts";

Deno.test("child inherits parent components when no override", () => {
  const resolved = resolvePrefabInheritance([
    { id: "base", components: { a: { x: 1, y: 2 } } },
    { id: "child", extends: "base", components: {} },
  ] as Prefab[]);
  const child = resolved.find((p) => p.id === "child")!;
  assertEquals(child.components, { a: { x: 1, y: 2 } });
});

Deno.test("child deep-merges nested objects with parent", () => {
  const resolved = resolvePrefabInheritance([
    { id: "base", components: { cfg: { speed: 1, jump: 2 } } },
    { id: "child", extends: "base", components: { cfg: { jump: 5 } } },
  ] as Prefab[]);
  const child = resolved.find((p) => p.id === "child")!;
  assertEquals(child.components, { cfg: { speed: 1, jump: 5 } });
});

Deno.test("arrays in component data are replaced, not concatenated", () => {
  const resolved = resolvePrefabInheritance([
    { id: "base", components: { list: { items: [1, 2, 3] } } },
    { id: "child", extends: "base", components: { list: { items: [9] } } },
  ] as Prefab[]);
  const child = resolved.find((p) => p.id === "child")!;
  assertEquals(child.components, { list: { items: [9] } });
});

Deno.test("child modelId overrides parent", () => {
  const resolved = resolvePrefabInheritance([
    { id: "base", modelId: "foo", components: {} },
    { id: "child", extends: "base", modelId: "bar", components: {} },
  ] as Prefab[]);
  const child = resolved.find((p) => p.id === "child")!;
  assertEquals(child.modelId, "bar");
});

Deno.test("child inherits modelId when not overridden", () => {
  const resolved = resolvePrefabInheritance([
    { id: "base", modelId: "foo", components: {} },
    { id: "child", extends: "base", components: {} },
  ] as Prefab[]);
  const child = resolved.find((p) => p.id === "child")!;
  assertEquals(child.modelId, "foo");
});

Deno.test("transitive inheritance composes root-to-leaf", () => {
  const resolved = resolvePrefabInheritance([
    { id: "a", components: { x: { v: 1 } } },
    { id: "b", extends: "a", components: { x: { w: 2 } } },
    { id: "c", extends: "b", components: { x: { u: 3 } } },
  ] as Prefab[]);
  const c = resolved.find((p) => p.id === "c")!;
  assertEquals(c.components, { x: { v: 1, w: 2, u: 3 } });
});

Deno.test("inheritance cycles throw", () => {
  assertThrows(
    () => resolvePrefabInheritance([
      { id: "a", extends: "b", components: {} },
      { id: "b", extends: "a", components: {} },
    ] as Prefab[]),
    Error,
    "cycle",
  );
});

Deno.test("unknown parent throws", () => {
  assertThrows(
    () => resolvePrefabInheritance([
      { id: "child", extends: "nope", components: {} },
    ] as Prefab[]),
    Error,
    "not found",
  );
});

Deno.test("duplicate prefab id throws", () => {
  assertThrows(
    () => resolvePrefabInheritance([
      { id: "dup", components: {} },
      { id: "dup", components: {} },
    ] as Prefab[]),
    Error,
    "more than once",
  );
});
