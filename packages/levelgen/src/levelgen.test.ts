import { assert, assertEquals, assertNotEquals, assertThrows } from "jsr:@std/assert";
import {
  bindStage,
  hashString,
  memoize,
  pipe,
  splitSeed,
  type Transformer,
  TransformerRegistry,
  withTrace,
} from "../mod.ts";

// Trivial transformers for composition + cache tests.
const addLen: Transformer<{ tag: string }, { tag: string; len: number }, { offset: number }> =
  (state, _seed, params) => ({ ...state, len: state.tag.length + params.offset });

const upper: Transformer<{ tag: string; len: number }, { tag: string; len: number }, Record<string, never>> =
  (state) => ({ ...state, tag: state.tag.toUpperCase() });

Deno.test("hashString: stable + non-trivial", () => {
  assertEquals(hashString(""),    hashString(""));
  assertEquals(hashString("foo"), hashString("foo"));
  assertNotEquals(hashString("foo"), hashString("bar"));
  assertNotEquals(hashString("foo"), hashString("foO"));
});

Deno.test("splitSeed: deterministic for same (seed, id)", () => {
  assertEquals(splitSeed(42, "noise"), splitSeed(42, "noise"));
});

Deno.test("splitSeed: different ids on same seed produce different streams", () => {
  const a = splitSeed(42, "noise");
  const b = splitSeed(42, "junctions");
  const c = splitSeed(42, "network");
  assertNotEquals(a, b);
  assertNotEquals(b, c);
  assertNotEquals(a, c);
});

Deno.test("splitSeed: same id on different seeds produces different streams", () => {
  assertNotEquals(splitSeed(0, "noise"), splitSeed(1, "noise"));
  assertNotEquals(splitSeed(42, "noise"), splitSeed(43, "noise"));
});

Deno.test("splitSeed: well-distributed over 1000 ids on a fixed seed", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 1000; i++) seen.add(splitSeed(7, `stage_${i}`));
  // Collisions theoretically possible but vanishingly rare with a finalizer.
  assertEquals(seen.size, 1000);
});

Deno.test("bindStage: produces a Stage that ignores params at call time", () => {
  const stage = bindStage("count", addLen, { offset: 100 }, 1);
  assertEquals(stage({ tag: "hi" }), { tag: "hi", len: 102 });
});

Deno.test("pipe: composes stages in order", () => {
  const s1 = bindStage("count", addLen, { offset: 0 }, 1);
  const s2 = bindStage("upper", upper, {}, 1);
  const piped = pipe(s1, s2);
  assertEquals(piped({ tag: "voxim" }), { tag: "VOXIM", len: 5 });
});

Deno.test("pipe: single-stage identity", () => {
  const s1 = bindStage("count", addLen, { offset: 3 }, 1);
  assertEquals(pipe(s1)({ tag: "ab" }), { tag: "ab", len: 5 });
});

Deno.test("TransformerRegistry: register + get round-trip", () => {
  const reg = new TransformerRegistry<{ tag: string }, { tag: string; len: number }, { offset: number }>();
  reg.register("addLen", addLen);
  assert(reg.has("addLen"));
  assertEquals(reg.ids(), ["addLen"]);
  const fn = reg.get("addLen");
  assertEquals(fn({ tag: "x" }, 0, { offset: 1 }), { tag: "x", len: 2 });
});

Deno.test("TransformerRegistry: duplicate id throws, unknown id throws", () => {
  const reg = new TransformerRegistry<{ tag: string }, { tag: string; len: number }, { offset: number }>();
  reg.register("a", addLen);
  assertThrows(() => reg.register("a", addLen), Error, "duplicate");
  assertThrows(() => reg.get("missing"), Error, "unknown");
});

Deno.test("withTrace: emits one event per call with computed hashes", () => {
  const events: Array<{ stageId: string; inputHash: number; outputHash: number }> = [];
  const traced = withTrace<{ tag: string }, { tag: string; len: number }, { offset: number }>(
    "addLen",
    addLen,
    (e) => events.push({ stageId: e.stageId, inputHash: e.inputHash, outputHash: e.outputHash }),
    (s) => hashString(s.tag),
    (s) => hashString(s.tag) ^ s.len,
  );
  traced({ tag: "hi" }, 1, { offset: 1 });
  traced({ tag: "hi" }, 1, { offset: 1 });
  assertEquals(events.length, 2);
  assertEquals(events[0].stageId, "addLen");
  assertEquals(events[0].inputHash, hashString("hi"));
});

Deno.test("memoize: identical (state, seed, params) → cache hit", () => {
  let calls = 0;
  const counted: Transformer<{ tag: string }, { tag: string; len: number }, { offset: number }> =
    (state, _seed, params) => {
      calls++;
      return { ...state, len: state.tag.length + params.offset };
    };
  const memo = memoize(
    counted,
    (s) => hashString(s.tag),
    (p) => p.offset,
  );
  memo({ tag: "hi" }, 1, { offset: 0 });
  memo({ tag: "hi" }, 1, { offset: 0 });
  memo({ tag: "hi" }, 1, { offset: 0 });
  assertEquals(calls, 1);
  assertEquals(memo.stats().hits, 2);
  assertEquals(memo.stats().misses, 1);
});

Deno.test("memoize: change params → cache miss, upstream stays cached", () => {
  let calls = 0;
  const counted: Transformer<{ tag: string }, { tag: string; len: number }, { offset: number }> =
    (state, _seed, params) => {
      calls++;
      return { ...state, len: state.tag.length + params.offset };
    };
  const memo = memoize(counted, (s) => hashString(s.tag), (p) => p.offset);
  memo({ tag: "hi" }, 1, { offset: 0 });
  memo({ tag: "hi" }, 1, { offset: 1 });
  assertEquals(calls, 2);
  // Recall the first input — still cached.
  memo({ tag: "hi" }, 1, { offset: 0 });
  assertEquals(calls, 2);
});

Deno.test("memoize: maxEntries evicts LRU", () => {
  const counted: Transformer<{ tag: string }, { tag: string; len: number }, { offset: number }> =
    (s, _seed, p) => ({ ...s, len: p.offset });
  const memo = memoize(counted, (s) => hashString(s.tag), (p) => p.offset, /*maxEntries*/ 2);
  memo({ tag: "a" }, 1, { offset: 0 });
  memo({ tag: "b" }, 1, { offset: 0 });
  memo({ tag: "c" }, 1, { offset: 0 });
  assertEquals(memo.stats().size, 2);
});
