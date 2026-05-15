/**
 * T-217 — prefab subtree spawn.
 *
 * A prefab declaring `children` spawns the root, then recursively spawns
 * each child, parents it via the scene graph, and applies its declared
 * local transform. Covers: entity count, parent wiring, local placement,
 * component walk on children, arbitrary-depth recursion, and the
 * unknown-child-id error path.
 */

import { assertEquals, assertThrows } from "jsr:@std/assert";
import { World } from "./world.ts";
import { defineComponent } from "./component.ts";
import type { Serialiser } from "./component.ts";
import type { Transform } from "./scene.ts";
import { spawnPrefab } from "./prefab.ts";
import type { PrefabLike, PrefabSpawnContext } from "./prefab.ts";

interface MarkData {
  tag: string;
}
const noopCodec: Serialiser<MarkData> = {
  encode: () => new Uint8Array(),
  decode: () => ({ tag: "" }),
};
const Mark = defineComponent({
  name: "mark" as const,
  networked: false,
  codec: noopCodec,
  default: (): MarkData => ({ tag: "" }),
});

interface LocalData {
  t: Transform;
}
const Local = defineComponent({
  name: "local" as const,
  networked: false,
  codec: { encode: () => new Uint8Array(), decode: () => ({ t: { x: 0, y: 0, z: 0, scale: 1 } }) } as Serialiser<LocalData>,
  default: (): LocalData => ({ t: { x: 0, y: 0, z: 0, scale: 1 } }),
});

/** Build a ctx over a fixed prefab table. preInstall is a no-op; placeChild
 *  records the child's local transform on a `Local` component. */
function makeCtx(
  table: Record<string, PrefabLike>,
): PrefabSpawnContext<{ id?: string }> {
  return {
    getPrefab: (id) => table[id],
    resolveComponent: (name) => (name === "mark" ? Mark : undefined),
    compoundInstaller: () => undefined,
    preInstall: () => {},
    placeChild: (w, childId, local) => w.write(childId, Local, { t: local }),
  };
}

Deno.test("prefab with two children → 3 entities, parented, placed", () => {
  const table: Record<string, PrefabLike> = {
    parent: {
      id: "parent",
      components: { mark: { tag: "root" } },
      children: [
        { prefabId: "leaf", local: { x: 1, y: 2, z: 3 } },
        { prefabId: "leaf", local: { x: -1, scale: 2 } },
      ],
    },
    leaf: { id: "leaf", components: { mark: { tag: "leaf" } } },
  };
  const w = new World();
  const rootId = spawnPrefab(w, makeCtx(table), "parent", {});

  const kids = w.getChildren(rootId);
  assertEquals(kids.length, 2);
  for (const k of kids) assertEquals(w.getParent(k), rootId);
  assertEquals(w.get(rootId, Mark), { tag: "root" });
  for (const k of kids) assertEquals(w.get(k, Mark), { tag: "leaf" });

  const locals = kids.map((k) => w.get(k, Local)!.t).sort((a, b) => a.x - b.x);
  assertEquals(locals[0], { x: -1, y: 0, z: 0, scale: 2 });
  assertEquals(locals[1], { x: 1, y: 2, z: 3, scale: 1 });
});

Deno.test("subtree recurses arbitrarily deep", () => {
  const table: Record<string, PrefabLike> = {
    a: { id: "a", components: {}, children: [{ prefabId: "b" }] },
    b: { id: "b", components: {}, children: [{ prefabId: "c" }] },
    c: { id: "c", components: {} },
  };
  const w = new World();
  const a = spawnPrefab(w, makeCtx(table), "a", {});
  const b = w.getChildren(a)[0];
  const c = w.getChildren(b)[0];
  assertEquals(w.getParent(c), b);
  assertEquals(w.descendants(a).length, 2);
});

Deno.test("unknown child prefab id throws", () => {
  const table: Record<string, PrefabLike> = {
    p: { id: "p", components: {}, children: [{ prefabId: "ghost" }] },
  };
  const w = new World();
  assertThrows(
    () => spawnPrefab(w, makeCtx(table), "p", {}),
    Error,
    "unknown prefab 'ghost'",
  );
});
