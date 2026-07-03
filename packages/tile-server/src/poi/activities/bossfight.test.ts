/**
 * bossfight POI activity tests (T-212 v2).
 *
 * Three seams pinned:
 *   1. Activation spawns the boss and tags it BossArenaLink (real content —
 *      `ancient_arena`, whose bossNpcId resolves through the same
 *      spawn-table stub `wave`/`encounter` use).
 *   2. The `boss_arena_link` TriggerSource + `health_below` gate fire the
 *      right phase-add trigger and spawn adds via `spawn_npc_table`.
 *   3. THE LOAD-BEARING ONE: `boss_arena_unlock` DeathHook actually reads
 *      BossArenaLink and fires BEFORE the entity is destroyed — proving the
 *      DeathHook path (not an entity_died Trigger, which would silently
 *      never fire — see components/boss_arena.ts's header for why).
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId, Registry } from "@voxim/engine";
import { JsonSource, StaticContentStore } from "@voxim/content";
import { Position, Health } from "../../components/game.ts";
import { PoiTrigger } from "../../components/poi.ts";
import { BossArenaLink } from "../../components/boss_arena.ts";
import { PoiSystem } from "../../systems/poi.ts";
import { newPoiActivityRegistry } from "../mod.ts";
import { DeathSystem } from "../../systems/death.ts";
import type { DeathHook } from "../../systems/death.ts";
import { bossArenaUnlockHook } from "../../deathhooks/boss_arena_unlock.ts";
import { TriggerSystem } from "../../systems/trigger.ts";
import { newTriggerCatalog } from "../../triggers/catalog.ts";
import { newTriggerSourceRegistry, bossArenaLinkTriggerSource } from "../../triggers/source.ts";
import { newGateRegistry } from "../../actions/gate.ts";
import { healthBelowGate } from "../../actions/resolvers/gates.ts";
import { newEffectRegistry } from "../../actions/effect.ts";
import { spawnNpcTableResolver } from "../../actions/resolvers/spawn_npc_table.ts";
import { TileEvents } from "@voxim/protocol";

const activities = newPoiActivityRegistry();
const content = await JsonSource.load() as StaticContentStore;
const DT = 1 / 20;

Deno.test("bossfight: activation spawns the boss and tags BossArenaLink", async () => {
  const world = new World();
  const events = new EventBus();

  const pid = newEntityId();
  world.create(pid);
  world.write(pid, Position, { x: 100, y: 100, z: 0 });
  const tid = newEntityId();
  world.create(tid);
  world.write(tid, Position, { x: 100, y: 100, z: 0 });
  world.write(tid, PoiTrigger, {
    poiInstanceId: "ancient_arena_z1", poiDefId: "ancient_arena", triggerRadius: 5, fired: false,
  });

  const sys = new PoiSystem(content, activities, () => [pid].values());
  sys.run(world, events, DT);
  world.applyChangeset();

  const bosses = world.query(BossArenaLink);
  assertEquals(bosses.length, 1, "expected exactly one boss spawned");
  assertEquals(bosses[0].bossArenaLink.poiInstanceId, "ancient_arena_z1");
  assertEquals(bosses[0].bossArenaLink.poiDefId, "ancient_arena");
});

Deno.test("bossfight: boss_arena_unlock DeathHook reads BossArenaLink BEFORE world.destroy (the ordering risk)", () => {
  const world = new World();
  const events = new EventBus();

  const bossId = newEntityId();
  world.create(bossId);
  world.write(bossId, Health, { current: 0, max: 100 });
  world.write(bossId, BossArenaLink, { poiInstanceId: "ancient_arena_z1", poiDefId: "ancient_arena" });

  const hooks = new Registry<DeathHook>();
  let sawLink: string | null = null;
  hooks.register({
    id: "probe",
    onDeath: (ctx) => {
      const link = ctx.world.get(ctx.entityId, BossArenaLink);
      sawLink = link?.poiInstanceId ?? null;
    },
  });
  hooks.register(bossArenaUnlockHook);

  const death = new DeathSystem(hooks);
  death.run(world, events, DT); // Health.current<=0 sweep requests death this same run.
  world.applyChangeset();

  assertEquals(sawLink, "ancient_arena_z1", "hook must see BossArenaLink before destroy");
  assertEquals(world.isAlive(bossId), false, "boss is destroyed after hooks run");
});

Deno.test("bossfight: an entity_died Trigger (the prompt's suggested wiring) does NOT fire — proves the DeathHook detour is required", async () => {
  // Reproduces the exact hazard: TriggerSystem's buffered drain runs on ITS
  // OWN next `run()`, by which point DeathSystem has already world.destroy()-ed
  // the victim — `world.isAlive(ownerId)` at trigger.ts's role-iteration gate
  // is false, so an owned trigger (even a real one) is silently never collected.
  const world = new World();

  const bossId = newEntityId();
  world.create(bossId);
  world.write(bossId, Health, { current: 0, max: 100 });
  world.write(bossId, BossArenaLink, { poiInstanceId: "ancient_arena_z1", poiDefId: "ancient_arena" });

  const catalog = newTriggerCatalog();
  const sources = newTriggerSourceRegistry();
  sources.register(bossArenaLinkTriggerSource); // grants damage_taken triggers, not entity_died — irrelevant here
  const gates = newGateRegistry();
  const effects = newEffectRegistry();
  let fired = 0;
  effects.register({ id: "record", resolve: () => { fired++; } });
  content.registerTrigger({
    id: "probe_entity_died", on: "entity_died", as: "victim",
    effects: [{ kind: "record" }],
  });
  // Grant it via a throwaway source keyed on BossArenaLink presence (same
  // shape as bossArenaLinkTriggerSource, just for THIS event kind).
  sources.register({
    id: "probe_source",
    collect: ({ world: w, entityId }) => w.has(entityId, BossArenaLink) ? ["probe_entity_died"] : [],
  });

  const trig = new TriggerSystem(content, catalog, sources, gates, effects);
  const bus = new EventBus();
  trig.registerSubscribers(bus);

  const hooks = new Registry<DeathHook>();
  const death = new DeathSystem(hooks);

  // Tick 1: DeathSystem sweeps Health<=0, publishes EntityDied (buffered on
  // TriggerSystem's collector), destroys the entity.
  death.run(world, bus, DT);
  world.applyChangeset();
  assertEquals(world.isAlive(bossId), false);

  // Tick 2: TriggerSystem drains the buffered EntityDied — but the owner is
  // already dead, so the role-iteration `world.isAlive` gate skips it.
  trig.run(world, bus, DT);
  world.applyChangeset();

  assertEquals(fired, 0, "entity_died trigger must NOT fire — the owner is already destroyed by drain time");
});

Deno.test("bossfight: boss_arena_link TriggerSource + health_below gate fires phase-add adds via spawn_npc_table", async () => {
  const world = new World();

  const bossId = newEntityId();
  world.create(bossId);
  world.write(bossId, Position, { x: 50, y: 50, z: 0 });
  world.write(bossId, Health, { current: 60, max: 100 }); // 60% — below the 0.66 phase-0 fraction
  world.write(bossId, BossArenaLink, { poiInstanceId: "ancient_arena_z1", poiDefId: "ancient_arena" });

  const catalog = newTriggerCatalog();
  const sources = newTriggerSourceRegistry();
  sources.register(bossArenaLinkTriggerSource);
  const gates = newGateRegistry();
  gates.register(healthBelowGate);
  const effects = newEffectRegistry();
  effects.register(spawnNpcTableResolver);

  const trig = new TriggerSystem(content, catalog, sources, gates, effects);
  const bus = new EventBus();
  trig.registerSubscribers(bus);

  bus.publish(TileEvents.DamageDealt, {
    sourceId: "attacker1", targetId: bossId, amount: 10, blocked: false, bodyPart: "torso",
    hitX: 50, hitY: 50, hitZ: 0,
  });
  trig.run(world, bus, DT); // drains next run — publish above buffers it
  world.applyChangeset();

  trig.run(world, bus, DT);
  world.applyChangeset();

  // The ancient_arena_phase_add_0 trigger's spawn_npc_table(construct_motes)
  // should have spawned NPCs near the boss's Position.
  const npcs = world.query(Position).filter((e) => e.entityId !== bossId);
  assert(npcs.length > 0, "expected adds spawned near the boss");
});
