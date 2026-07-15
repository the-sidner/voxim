/**
 * T-217 — prefab subtree spawn.
 *
 * A prefab declaring `children` spawns the root, then recursively spawns
 * each child, parents it via the scene graph, and applies its declared
 * local transform. Covers: entity count, parent wiring, local placement,
 * component walk on children, arbitrary-depth recursion, and the
 * unknown-child-id error path.
 *
 * T-334 — seeded pool/probability on `children`. Covers: determinism (same
 * seed twice → byte-identical resolved subtree), different seeds diverging,
 * `probability` skipping entries, and `pool` picking a variant — all via
 * the ONE shared `resolveSeededPick` the children walk now uses.
 */

import { assertEquals, assertNotEquals, assertThrows } from "jsr:@std/assert";
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
  parents: Map<string, string> = new Map(),
): PrefabSpawnContext<{ id?: string }> {
  return {
    getPrefab: (id) => table[id],
    resolveComponent: (name) => (name === "mark" ? Mark : undefined),
    compoundInstaller: () => undefined,
    preInstall: () => {},
    placeChild: (w, childId, parentId, local) => {
      w.write(childId, Local, { t: local });
      parents.set(childId, parentId);
    },
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
  const parents = new Map<string, string>();
  const rootId = spawnPrefab(w, makeCtx(table, parents), "parent", {});

  const kids = w.getChildren(rootId);
  assertEquals(kids.length, 2);
  for (const k of kids) assertEquals(w.getParent(k), rootId);
  // placeChild receives the parent id so the service can compose world-space.
  for (const k of kids) assertEquals(parents.get(k), rootId);
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

// ── T-334: seeded pool/probability on children ──────────────────────────────

interface SeededOverrides {
  id?: string;
  seed?: number;
}

/** Like makeCtx, but wires `resolveSeed` so the children walk draws off the
 *  override's `seed` — mirroring how tile-server threads `ov.seed` through
 *  to both ModelRef and (as of T-334) child pool/probability resolution. */
function makeSeededCtx(table: Record<string, PrefabLike>): PrefabSpawnContext<SeededOverrides> {
  return {
    getPrefab: (id) => table[id],
    resolveComponent: (name) => (name === "mark" ? Mark : undefined),
    compoundInstaller: () => undefined,
    preInstall: () => {},
    resolveSeed: (ov) => ov.seed ?? 0,
  };
}

/** A tree-like prefab: one static trunk child + a pool of 3 branch variants,
 *  each independently gated by `probability`, mirroring tree_oak's real
 *  shape (1 static trunk + N pool/probability branch entries). */
function makeSeededTable(): Record<string, PrefabLike> {
  return {
    tree: {
      id: "tree",
      components: {},
      children: [
        { prefabId: "trunk" },
        { pool: ["branch_a", "branch_b", "branch_c"], probability: 0.7 },
        { pool: ["branch_a", "branch_b", "branch_c"], probability: 0.7 },
        { pool: ["branch_a", "branch_b", "branch_c"], probability: 0.7 },
        { pool: ["branch_a", "branch_b", "branch_c"], probability: 0.7 },
        { pool: ["branch_a", "branch_b", "branch_c"], probability: 0.7 },
      ],
    },
    trunk: { id: "trunk", components: { mark: { tag: "trunk" } } },
    branch_a: { id: "branch_a", components: { mark: { tag: "branch_a" } } },
    branch_b: { id: "branch_b", components: { mark: { tag: "branch_b" } } },
    branch_c: { id: "branch_c", components: { mark: { tag: "branch_c" } } },
  };
}

/** Spawn the tree and return the sorted tags of its resolved children —
 *  a compact fingerprint of the seeded subtree's shape. */
function spawnTreeTags(table: Record<string, PrefabLike>, seed: number): string[] {
  const w = new World();
  const root = spawnPrefab(w, makeSeededCtx(table), "tree", { seed });
  return w.getChildren(root).map((k) => w.get(k, Mark)!.tag).sort();
}

Deno.test("seeded children: same seed spawns a byte-identical subtree, twice", () => {
  const table = makeSeededTable();
  const first = spawnTreeTags(table, 42);
  const second = spawnTreeTags(table, 42);
  assertEquals(first, second);
});

Deno.test("seeded children: different seeds diverge", () => {
  const table = makeSeededTable();
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => spawnTreeTags(table, s).join(","));
  // Not every pair need differ, but across 8 seeds on a 5-slot pool+probability
  // tree, at least one must diverge from the first — otherwise the seed isn't
  // reaching the PRNG at all.
  assertNotEquals(new Set(seeds).size, 1);
});

Deno.test("seeded children: probability < 1.0 can skip an entry entirely", () => {
  const table: Record<string, PrefabLike> = {
    p: {
      id: "p",
      components: {},
      children: [{ prefabId: "leaf", probability: 0.0 }],
    },
    leaf: { id: "leaf", components: {} },
  };
  const w = new World();
  const root = spawnPrefab(w, makeSeededCtx(table), "p", { seed: 7 });
  assertEquals(w.getChildren(root).length, 0);
});

Deno.test("seeded children: probability 1.0 (default) always spawns", () => {
  const table: Record<string, PrefabLike> = {
    p: { id: "p", components: {}, children: [{ prefabId: "leaf" }] },
    leaf: { id: "leaf", components: {} },
  };
  const w = new World();
  const root = spawnPrefab(w, makeSeededCtx(table), "p", { seed: 999 });
  assertEquals(w.getChildren(root).length, 1);
});

Deno.test("seeded children: pool picks exactly one variant, deterministically", () => {
  const table: Record<string, PrefabLike> = {
    p: {
      id: "p",
      components: {},
      children: [{ pool: ["a", "b", "c"] }],
    },
    a: { id: "a", components: { mark: { tag: "a" } } },
    b: { id: "b", components: { mark: { tag: "b" } } },
    c: { id: "c", components: { mark: { tag: "c" } } },
  };
  const w = new World();
  const root = spawnPrefab(w, makeSeededCtx(table), "p", { seed: 5 });
  const kids = w.getChildren(root);
  assertEquals(kids.length, 1);
  const tag = w.get(kids[0], Mark)!.tag;
  assertEquals(["a", "b", "c"].includes(tag), true);

  // Same seed, same pick.
  const w2 = new World();
  const root2 = spawnPrefab(w2, makeSeededCtx(table), "p", { seed: 5 });
  const tag2 = w2.get(w2.getChildren(root2)[0], Mark)!.tag;
  assertEquals(tag2, tag);
});
