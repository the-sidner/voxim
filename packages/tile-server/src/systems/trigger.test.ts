/**
 * TriggerSystem (T-259a) — the fourth primitive, standalone.
 *
 * Locks the buffered runtime: a weapon trigger procs on `hit_landed` with
 * the event's other party bound as target; `as` filters roles; conditions
 * gate through the action gate registry; the internal cooldown throttles;
 * and trigger-fired events are tagged `viaTrigger` and dropped by the
 * collectors (no proc chains, v1).
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import { JsonSource, StaticContentStore } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import { Equipment } from "../components/equipment.ts";
import { TriggerSystem } from "./trigger.ts";
import { newTriggerCatalog } from "../triggers/catalog.ts";
import { newTriggerSourceRegistry, equipmentTriggerSource } from "../triggers/source.ts";
import { newGateRegistry } from "../actions/gate.ts";
import { newEffectRegistry } from "../actions/effect.ts";
import type { EffectResolver, ResolveContext } from "../actions/effect.ts";

const content = await JsonSource.load() as StaticContentStore;
const DT = 1 / 20;

// Test content: a fang weapon granting an on-hit trigger. Registered once
// into this file's content instance (each test file loads its own).
content.registerPrefab({ id: "test_fang", components: {}, triggers: ["test_drain"] });
content.registerPrefab({ id: "test_ward_robe", components: {}, triggers: ["test_when_hit"] });
content.registerTrigger({
  id: "test_drain", on: "hit_landed", as: "attacker",
  effects: [{ kind: "record", params: { tag: "drain" } }],
});
content.registerTrigger({
  id: "test_when_hit", on: "hit_landed", as: "target",
  effects: [{ kind: "record", params: { tag: "thorns" } }],
});
content.registerTrigger({
  id: "test_gated", on: "hit_landed", as: "attacker",
  conditions: [{ gate: "test_flag", params: { pass: false } }],
  effects: [{ kind: "record", params: { tag: "gated" } }],
});
content.registerTrigger({
  id: "test_icd", on: "hit_landed", as: "attacker", internalCooldownTicks: 1,
  effects: [{ kind: "record", params: { tag: "icd" } }],
});
content.registerTrigger({
  id: "test_chain", on: "hit_landed", as: "attacker",
  effects: [{ kind: "republish", params: {} }],
});

interface Fired {
  tag: unknown;
  entityId: EntityId;
  target: unknown;
}

function harness(weaponPrefab: string) {
  const world = new World();
  const bus = new EventBus();
  const fired: Fired[] = [];

  const recorder: EffectResolver = {
    id: "record",
    resolve(ctx: ResolveContext) {
      fired.push({ tag: ctx.params.tag, entityId: ctx.entityId, target: ctx.params.overrideTargetId });
    },
  };
  // Re-publishes the catalog event from inside a trigger-fired effect —
  // the wrapped emitter must tag it so collectors drop it.
  const republisher: EffectResolver = {
    id: "republish",
    resolve(ctx: ResolveContext) {
      fired.push({ tag: "chain", entityId: ctx.entityId, target: ctx.params.overrideTargetId });
      ctx.events.publish(TileEvents.HitLanded, {
        attackerId: ctx.entityId, targetId: ctx.entityId, bodyPart: "torso", damage: 1, blocked: false,
      });
    },
  };
  const flagGate = {
    id: "test_flag",
    test: (ctx: { params: Record<string, unknown> }) => ctx.params.pass === true,
  };

  const gates = newGateRegistry();
  gates.register(flagGate);
  const effects = newEffectRegistry();
  effects.register(recorder);
  effects.register(republisher);
  const sources = newTriggerSourceRegistry();
  sources.register(equipmentTriggerSource);

  const sys = new TriggerSystem(content, newTriggerCatalog(), sources, gates, effects);
  sys.registerSubscribers(bus);

  const owner = newEntityId();
  world.create(owner);
  world.write(owner, Equipment, {
    weapon: { entityId: "w1", prefabId: weaponPrefab },
    offHand: null, head: null, chest: null, legs: null, feet: null, back: null,
  });
  const other = newEntityId();
  world.create(other);

  const hit = (attackerId: EntityId, targetId: EntityId) =>
    bus.publish(TileEvents.HitLanded, { attackerId, targetId, bodyPart: "torso", damage: 5, blocked: false });
  const tick = (serverTick: number) => {
    sys.prepare(serverTick, { spatial: null as never, pendingCommands: new Map() });
    // The real bus doubles as the run's emitter so wrapped re-publishes
    // reach the collectors synchronously (the proc-chain test).
    sys.run(world, bus, DT);
    world.applyChangeset();
  };

  return { world, bus, fired, owner, other, hit, tick };
}

Deno.test("a weapon trigger procs on hit_landed with the victim bound as target", () => {
  const h = harness("test_fang");
  h.hit(h.owner, h.other); // collected at "flush"
  h.tick(1); // drained next tick
  assertEquals(h.fired.length, 1);
  assertEquals(h.fired[0], { tag: "drain", entityId: h.owner, target: h.other });
});

Deno.test("`as` filters roles: an on-hit weapon does not proc when its owner IS hit", () => {
  const h = harness("test_fang");
  h.hit(h.other, h.owner); // owner is the target, trigger wants attacker
  h.tick(1);
  assertEquals(h.fired.length, 0);
});

Deno.test("`as: target` armor procs when the wearer is hit", () => {
  const h = harness("test_ward_robe");
  h.hit(h.other, h.owner);
  h.tick(1);
  assertEquals(h.fired.length, 1);
  assertEquals(h.fired[0], { tag: "thorns", entityId: h.owner, target: h.other });
});

Deno.test("conditions gate through the action gate registry", () => {
  const h = harness("test_fang");
  // Swap the fang's trigger for the gated one (params.pass: false).
  h.world.write(h.owner, Equipment, {
    weapon: { entityId: "w1", prefabId: "test_gate_fang" },
    offHand: null, head: null, chest: null, legs: null, feet: null, back: null,
  });
  content.registerPrefab({ id: "test_gate_fang", components: {}, triggers: ["test_gated"] });
  h.hit(h.owner, h.other);
  h.tick(1);
  assertEquals(h.fired.length, 0, "failing condition blocks the trigger");
});

Deno.test("internal cooldown throttles: once per ICD window, even across buffered duplicates", () => {
  const h = harness("test_icd_fang");
  content.registerPrefab({ id: "test_icd_fang", components: {}, triggers: ["test_icd"] });
  h.world.write(h.owner, Equipment, {
    weapon: { entityId: "w1", prefabId: "test_icd_fang" },
    offHand: null, head: null, chest: null, legs: null, feet: null, back: null,
  });

  // Two hits land the same tick — the in-run stamp blocks the second.
  h.hit(h.owner, h.other);
  h.hit(h.owner, h.other);
  h.tick(1);
  assertEquals(h.fired.length, 1, "in-run ICD blocks the same-drain duplicate");

  // Next tick: committed ICD still active.
  h.hit(h.owner, h.other);
  h.tick(2);
  assertEquals(h.fired.length, 1, "committed ICD blocks");

  // After the ICD ticks down (decrement is itself deferred → one extra tick).
  h.tick(3);
  h.hit(h.owner, h.other);
  h.tick(4);
  assertEquals(h.fired.length, 2, "fires again after the ICD expires");
});

Deno.test("no proc chains: trigger-fired events are tagged and dropped by collectors", () => {
  const h = harness("test_chain_fang");
  content.registerPrefab({ id: "test_chain_fang", components: {}, triggers: ["test_chain"] });
  h.world.write(h.owner, Equipment, {
    weapon: { entityId: "w1", prefabId: "test_chain_fang" },
    offHand: null, head: null, chest: null, legs: null, feet: null, back: null,
  });

  h.hit(h.owner, h.other);
  h.tick(1); // fires once; its re-published HitLanded is tagged → dropped
  h.tick(2); // nothing buffered
  h.tick(3);
  const chained = h.fired.filter((f) => f.tag === "chain");
  assertEquals(chained.length, 1, "the republished event never re-enters");
});

Deno.test("an entity with no trigger sources is inert", () => {
  const h = harness("test_fang");
  const naked = newEntityId();
  h.world.create(naked);
  h.hit(naked, h.other);
  h.tick(1);
  assertEquals(h.fired.length, 0);
  assert(h.world.isAlive(naked));
});
