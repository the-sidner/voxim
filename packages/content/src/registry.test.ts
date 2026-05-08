import { assertEquals, assertThrows } from "jsr:@std/assert";
import { ContentRegistry } from "./registry.ts";

interface Item {
  readonly id: string;
  readonly tags?: readonly string[];
  readonly value?: number;
}

function newReg() {
  return new ContentRegistry<Item>({
    kind: "test",
    idOf: (it) => it.id,
  });
}

Deno.test("register + get round-trips", () => {
  const r = newReg();
  r.register({ id: "a", value: 1 });
  r.register({ id: "b", value: 2 });
  assertEquals(r.get("a")?.value, 1);
  assertEquals(r.get("b")?.value, 2);
  assertEquals(r.get("missing"), undefined);
  assertEquals(r.size, 2);
});

Deno.test("getOrThrow throws with the kind in the message", () => {
  const r = newReg();
  const err = assertThrows(() => r.getOrThrow("missing"));
  if (!(err as Error).message.includes("test") ||
      !(err as Error).message.includes("missing")) {
    throw new Error("error message should reference kind and id");
  }
});

Deno.test("duplicate register throws", () => {
  const r = newReg();
  r.register({ id: "a" });
  assertThrows(() => r.register({ id: "a" }), Error, "duplicate id");
});

Deno.test("validate hook runs before insert", () => {
  let count = 0;
  const r = new ContentRegistry<Item>({
    kind: "validated",
    idOf: (it) => it.id,
    validate: (it) => {
      count++;
      if ((it.value ?? 0) < 0) throw new Error("negative value rejected");
    },
  });
  r.register({ id: "a", value: 1 });
  assertEquals(count, 1);
  // Reject — verify it didn't end up in the registry
  assertThrows(() => r.register({ id: "b", value: -1 }));
  assertEquals(r.has("b"), false);
});

Deno.test("byTag is O(k) and indexed at register-time", () => {
  const r = newReg();
  r.register({ id: "iron",      tags: ["metal", "iron"] });
  r.register({ id: "copper",    tags: ["metal", "copper"] });
  r.register({ id: "worn_iron", tags: ["metal", "iron", "worn"] });
  r.register({ id: "oak",       tags: ["wood"] });
  r.register({ id: "untagged" });

  const metals = r.byTag("metal");
  assertEquals(metals.length, 3);
  assertEquals(new Set(metals.map((i) => i.id)),
               new Set(["iron", "copper", "worn_iron"]));

  const ironLike = r.byTag("iron");
  assertEquals(ironLike.length, 2);
  assertEquals(r.byTag("nonexistent"), []);
});

Deno.test("forEach + values + ids iterate every item", () => {
  const r = newReg();
  for (const id of ["a", "b", "c"]) r.register({ id });
  const seen: string[] = [];
  r.forEach((_, id) => seen.push(id));
  assertEquals(seen.sort(), ["a", "b", "c"]);
  assertEquals([...r.ids()].sort(), ["a", "b", "c"]);
  assertEquals([...r.values()].length, 3);
});

Deno.test("empty id rejected", () => {
  const r = newReg();
  assertThrows(() => r.register({ id: "" }), Error, "non-string or empty");
});
