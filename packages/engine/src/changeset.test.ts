/**
 * Changeset op-log semantics (T-249 move 1+2, engine half).
 *
 * One ordered pending-op log: program order between set / mutate / remove
 * on the same (entity, component) is preserved at commit, mutate composes
 * on earlier ops' results, and the applied changeset nets to exactly one
 * entry per changed (entity, component).
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World } from "./world.ts";
import { defineComponent } from "./component.ts";
import type { Serialiser } from "./component.ts";

interface CounterData {
  n: number;
}
const counterCodec: Serialiser<CounterData> = {
  encode: () => new Uint8Array(),
  decode: () => ({ n: 0 }),
};
const Counter = defineComponent({
  name: "counter" as const,
  networked: false,
  codec: counterCodec,
  default: (): CounterData => ({ n: 0 }),
});
const Tag = defineComponent({
  name: "tag" as const,
  networked: false,
  codec: counterCodec as unknown as Serialiser<Record<never, never>>,
  default: () => ({}),
});
// A networked counter whose wireEquals ignores everything but `n`'s low bit
// — a stand-in for "a field that must commit every tick for internal
// correctness, but whose full value isn't wire-meaningful" (T-363's
// ActiveActions.ticksInPhase / Resource's quantised drift).
const NetCounter = defineComponent({
  name: "netCounter" as const,
  wireId: 1,
  codec: counterCodec,
  default: (): CounterData => ({ n: 0 }),
  wireEquals: (a: CounterData, b: CounterData) => (a.n % 2) === (b.n % 2),
});

Deno.test("set then remove nets to a removal (program order)", () => {
  const world = new World();
  const id = world.create();
  world.write(id, Tag, {});

  world.set(id, Tag, {});
  world.remove(id, Tag);
  const cs = world.applyChangeset();

  assertEquals(world.has(id, Tag), false, "later remove wins");
  assertEquals(cs.sets.length, 0);
  assertEquals(cs.removals.length, 1);
});

Deno.test("remove then set nets to a set (the stagger-tag / PendingReaction case)", () => {
  const world = new World();
  const id = world.create();
  world.write(id, Counter, { n: 1 });

  world.remove(id, Counter); // consumed…
  world.set(id, Counter, { n: 2 }); // …and re-posted the same tick
  const cs = world.applyChangeset();

  assertEquals(world.get(id, Counter), { n: 2 }, "later set wins");
  assertEquals(cs.sets.length, 1);
  assertEquals(cs.removals.length, 0);
});

Deno.test("two mutates compose (two same-tick hits both subtract)", () => {
  const world = new World();
  const id = world.create();
  world.write(id, Counter, { n: 50 });

  world.mutate(id, Counter, (c) => ({ n: c.n - 30 }));
  world.mutate(id, Counter, (c) => ({ n: c.n - 30 }));
  world.applyChangeset();

  assertEquals(world.get(id, Counter), { n: -10 }, "both contributions land");
});

Deno.test("set then mutate: fn sees the set value, not the committed one", () => {
  const world = new World();
  const id = world.create();
  world.write(id, Counter, { n: 1 });

  world.set(id, Counter, { n: 100 });
  world.mutate(id, Counter, (c) => ({ n: c.n + 1 }));
  world.applyChangeset();

  assertEquals(world.get(id, Counter), { n: 101 });
});

Deno.test("mutate on an absent component is skipped (incl. removed-earlier-this-tick)", () => {
  const world = new World();
  const id = world.create();

  // Never present:
  world.mutate(id, Counter, (c) => ({ n: c.n + 1 }));
  let cs = world.applyChangeset();
  assertEquals(world.has(id, Counter), false);
  assertEquals(cs.sets.length, 0);

  // Removed earlier in the same tick:
  world.write(id, Counter, { n: 5 });
  world.remove(id, Counter);
  world.mutate(id, Counter, (c) => ({ n: c.n + 1 }));
  cs = world.applyChangeset();
  assertEquals(world.has(id, Counter), false, "remove stands; mutate skipped");
  assertEquals(cs.removals.length, 1);
});

Deno.test("encode-once: N ops on one key produce one changeset entry, one version bump", () => {
  const world = new World();
  const id = world.create();
  world.write(id, Counter, { n: 0 }); // version 1

  world.set(id, Counter, { n: 1 });
  world.mutate(id, Counter, (c) => ({ n: c.n + 1 }));
  world.set(id, Counter, { n: 10 });
  world.mutate(id, Counter, (c) => ({ n: c.n + 5 }));
  const cs = world.applyChangeset();

  assertEquals(cs.sets.length, 1, "one entry per (entity, component)");
  assertEquals(cs.sets[0].data, { n: 15 });
  assertEquals(cs.sets[0].version, 2, "single version bump per commit");
  assertEquals(world.get(id, Counter), { n: 15 });
});

Deno.test("reads during the tick still see committed state (isolation holds)", () => {
  const world = new World();
  const id = world.create();
  world.write(id, Counter, { n: 7 });

  world.mutate(id, Counter, (c) => ({ n: c.n * 2 }));
  assertEquals(world.get(id, Counter), { n: 7 }, "mutate is deferred");
  world.applyChangeset();
  assertEquals(world.get(id, Counter), { n: 14 });
});

Deno.test("remove of a never-present component stays a silent no-op", () => {
  const world = new World();
  const id = world.create();
  world.remove(id, Counter);
  const cs = world.applyChangeset();
  assertEquals(cs.removals.length, 0);
  assertEquals(cs.sets.length, 0);
});

Deno.test("ops on a destroyed entity are dropped", () => {
  const world = new World();
  const id = world.create();
  world.write(id, Counter, { n: 1 });
  world.destroy(id);
  world.mutate(id, Counter, (c) => ({ n: c.n + 1 }));
  world.set(id, Counter, { n: 9 });
  const cs = world.applyChangeset();
  assertEquals(cs.sets.length, 0);
  assert(cs.destroys.includes(id));
});

// ---- wireEquals (T-363) ----------------------------------------------------

Deno.test("wireEquals: a wire-equal set still commits (world.get sees the true value) but is absent from cs.sets", () => {
  const world = new World();
  const id = world.create();
  world.write(id, NetCounter, { n: 0 });

  world.set(id, NetCounter, { n: 100 }); // even → even: wire-equal to 0
  const cs = world.applyChangeset();

  assertEquals(world.get(id, NetCounter), { n: 100 }, "the commit always lands");
  assertEquals(cs.sets.length, 0, "wireEquals suppresses the changeset entry");
});

Deno.test("wireEquals: a wire-unequal set commits AND ships", () => {
  const world = new World();
  const id = world.create();
  world.write(id, NetCounter, { n: 0 });

  world.set(id, NetCounter, { n: 1 }); // odd vs even: wire-unequal
  const cs = world.applyChangeset();

  assertEquals(world.get(id, NetCounter), { n: 1 });
  assertEquals(cs.sets.length, 1);
  assertEquals(cs.sets[0].data, { n: 1 });
});

Deno.test("wireEquals: the very first set for a fresh component always ships (nothing to compare against)", () => {
  const world = new World();
  const id = world.create();

  world.set(id, NetCounter, { n: 0 });
  const cs = world.applyChangeset();

  assertEquals(cs.sets.length, 1, "a brand-new component has no prior value — wireEquals never runs");
});

Deno.test("wireEquals: version still bumps on a suppressed commit (it's a real write, just not a wire-visible one)", () => {
  const world = new World();
  const id = world.create();
  world.write(id, NetCounter, { n: 0 });
  const v0 = world.getVersion(id, NetCounter);

  world.set(id, NetCounter, { n: 2 }); // even → even: suppressed
  world.applyChangeset();

  assertEquals(world.getVersion(id, NetCounter), v0 + 1, "version tracks writes, not wire visibility");
});

Deno.test("wireEquals: repeated suppressed writes keep composing internally across many ticks", () => {
  const world = new World();
  const id = world.create();
  world.write(id, NetCounter, { n: 0 });

  for (let i = 1; i <= 50; i++) {
    world.set(id, NetCounter, { n: world.get(id, NetCounter)!.n + 2 }); // always stays even
    const cs = world.applyChangeset();
    assertEquals(cs.sets.length, 0, `tick ${i}: an always-even counter stays wire-equal`);
  }
  assertEquals(world.get(id, NetCounter), { n: 100 }, "the true value still accumulated every tick underneath");
});
